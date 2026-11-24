package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"fluxparcel.xyz/apps/api/internal/foundation"
	"fluxparcel.xyz/apps/api/migrations"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/redis/go-redis/v9"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		slog.Error("fluxparcel stopped", "reason", err.Error())
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: fluxparcel api|migrate|worker|init-storage")
	}
	if os.Args[1] == "init-storage" {
		return initStorage(ctx)
	}
	settings, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil || os.Getenv("DATABASE_URL") == "" {
		return fmt.Errorf("invalid DATABASE_URL")
	}
	db, err := pgxpool.NewWithConfig(ctx, settings)
	if err != nil {
		return fmt.Errorf("create database pool")
	}
	defer db.Close()
	switch os.Args[1] {
	case "migrate":
		if err := migrations.Apply(ctx, db); err != nil {
			return fmt.Errorf("migration failed")
		}
		return nil
	case "worker":
		for {
			if _, err := db.Exec(ctx, `DELETE FROM device_sessions WHERE id IN (
                SELECT id FROM device_sessions WHERE expires_at<=now() ORDER BY expires_at LIMIT 500)`); err != nil && ctx.Err() == nil {
				slog.Warn("session cleanup failed")
			}
			if _, err := db.Exec(ctx, `DELETE FROM email_verifications WHERE token_hash IN (
                SELECT token_hash FROM email_verifications WHERE expires_at<=now() ORDER BY expires_at LIMIT 500)`); err != nil && ctx.Err() == nil {
				slog.Warn("verification cleanup failed")
			}
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Minute):
			}
		}
	case "api":
		return serve(ctx, db)
	default:
		return fmt.Errorf("usage: fluxparcel api|migrate|worker|init-storage")
	}
}

func serve(ctx context.Context, db *pgxpool.Pool) error {
	origin := os.Getenv("APP_ORIGIN")
	public, err := url.Parse(origin)
	development := os.Getenv("APP_ENV") == "development"
	if err != nil || public.Host == "" || public.User != nil || public.Path != "" || public.RawQuery != "" || public.Fragment != "" ||
		(public.Scheme != "https" && (!development || public.Scheme != "http")) {
		return fmt.Errorf("APP_ORIGIN must be an HTTPS origin, or HTTP in development")
	}
	cacheOptions, err := redis.ParseURL(os.Getenv("REDIS_URL"))
	if err != nil {
		return fmt.Errorf("invalid REDIS_URL")
	}
	cache := redis.NewClient(cacheOptions)
	defer cache.Close()
	objects, err := storageClient(development)
	if err != nil {
		return err
	}
	smtpAddress, from := os.Getenv("SMTP_ADDRESS"), os.Getenv("SMTP_FROM")
	if _, _, err := net.SplitHostPort(smtpAddress); err != nil {
		return fmt.Errorf("SMTP_ADDRESS must include SMTP relay host and port")
	}
	if sender, err := mail.ParseAddress(from); err != nil || sender.Address != from {
		return fmt.Errorf("invalid SMTP_FROM")
	}
	app := &foundation.Server{
		DB: db, Cache: cache, Objects: objects, Bucket: os.Getenv("S3_BUCKET"), Origin: origin,
		SecureCookies: public.Scheme == "https", TrustProxy: os.Getenv("TRUST_PROXY") == "true",
		SendVerification: func(ctx context.Context, to, token string) error {
			dialer := net.Dialer{Timeout: 3 * time.Second}
			conn, err := dialer.DialContext(ctx, "tcp", smtpAddress)
			if err != nil {
				return err
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
				return err
			}
			host, _, _ := net.SplitHostPort(smtpAddress)
			client, err := smtp.NewClient(conn, host)
			if err != nil {
				return err
			}
			defer client.Close()
			if err := client.Mail(from); err != nil {
				return err
			}
			if err := client.Rcpt(to); err != nil {
				return err
			}
			writer, err := client.Data()
			if err != nil {
				return err
			}
			body := strings.Join([]string{
				"From: " + from, "To: " + to, "Subject: Verify your FluxParcel email",
				"Content-Type: text/plain; charset=utf-8", "",
				"Verify your email within 24 hours:", origin + "/verify#" + token, "",
			}, "\r\n")
			if _, err := writer.Write([]byte(body)); err != nil {
				return err
			}
			return writer.Close()
		},
	}
	server := &http.Server{
		Addr: ":8080", Handler: app.Handler(), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.ListenAndServe() }()
	slog.Info("api listening", "port", 8080)
	select {
	case err := <-stopped:
		if err != http.ErrServerClosed {
			return err
		}
		return nil
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}

func storageClient(development bool) (*minio.Client, error) {
	endpoint, err := url.Parse(os.Getenv("S3_ENDPOINT"))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "https" && (!development || endpoint.Scheme != "http")) ||
		endpoint.User != nil || endpoint.Path != "" || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		os.Getenv("S3_ACCESS_KEY") == "" || os.Getenv("S3_SECRET_KEY") == "" || os.Getenv("S3_BUCKET") == "" {
		return nil, fmt.Errorf("invalid S3 configuration")
	}
	objects, err := minio.New(endpoint.Host, &minio.Options{
		Creds:  credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""),
		Secure: endpoint.Scheme == "https",
	})
	if err != nil {
		return nil, fmt.Errorf("initialize S3 client")
	}
	return objects, nil
}

func initStorage(ctx context.Context) error {
	objects, err := storageClient(os.Getenv("APP_ENV") == "development")
	if err != nil {
		return err
	}
	bucket := os.Getenv("S3_BUCKET")
	limit, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	for limit.Err() == nil {
		attempt, stop := context.WithTimeout(limit, 3*time.Second)
		exists, err := objects.BucketExists(attempt, bucket)
		if err == nil && !exists {
			err = objects.MakeBucket(attempt, bucket, minio.MakeBucketOptions{Region: "us-east-1"})
		}
		stop()
		if err == nil {
			return nil
		}
		select {
		case <-limit.Done():
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("private bucket initialization failed")
}
