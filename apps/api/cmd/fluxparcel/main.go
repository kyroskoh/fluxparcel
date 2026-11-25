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
	"strconv"
	"strings"
	"syscall"
	"time"

	"fluxparcel.xyz/apps/api/internal/foundation"
	"fluxparcel.xyz/apps/api/migrations"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/minio/minio-go/v7/pkg/lifecycle"
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
		return work(ctx, db)
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
	rateLimitScale := int64(1)
	if value := os.Getenv("RATE_LIMIT_SCALE"); value != "" {
		rateLimitScale, err = strconv.ParseInt(value, 10, 64)
		if err != nil || rateLimitScale < 1 || rateLimitScale > 20 {
			return fmt.Errorf("RATE_LIMIT_SCALE must be between 1 and 20")
		}
	}
	partSize := int64(foundation.DefaultPartSize)
	if value := os.Getenv("TRANSFER_PART_SIZE"); value != "" {
		partSize, err = strconv.ParseInt(value, 10, 64)
		if err != nil || partSize < foundation.MinPartSize || partSize > foundation.MaxPartSize || partSize%(1<<20) != 0 {
			return fmt.Errorf("TRANSFER_PART_SIZE must be 5–64 MiB in whole MiB, in bytes")
		}
	}
	maxFileSize := int64(foundation.DefaultMaxFileSize)
	if value := os.Getenv("MAX_FILE_SIZE"); value != "" {
		maxFileSize, err = strconv.ParseInt(value, 10, 64)
		if err != nil || maxFileSize < 1<<20 || maxFileSize > 64<<30 {
			return fmt.Errorf("MAX_FILE_SIZE must be between 1 MiB and 64 GiB in bytes")
		}
	}
	retention, err := lifecycleSettings()
	if err != nil {
		return err
	}
	var admins []string
	for _, email := range strings.Split(os.Getenv("ADMIN_EMAILS"), ",") {
		if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
			admins = append(admins, email)
		}
	}
	app := &foundation.Server{
		DB: db, Cache: cache, Objects: objects, Bucket: os.Getenv("S3_BUCKET"), Origin: origin,
		SecureCookies: public.Scheme == "https", TrustProxy: os.Getenv("TRUST_PROXY") == "true",
		RateLimitScale: rateLimitScale,
		MaxFileSize:    maxFileSize, PartSize: partSize,
		FileRetention: retention.file, SnapshotRetention: retention.snapshot, AdminEmails: admins,
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
			// Storage-level backstop for abandoned multipart uploads. The worker's cleanup is authoritative;
			// some S3-compatible stores do not support lifecycle rules, so a refusal is only reported.
			rules := lifecycle.NewConfiguration()
			rules.Rules = []lifecycle.Rule{{ID: "abort-abandoned-uploads", Status: "Enabled",
				RuleFilter:                     lifecycle.Filter{Prefix: "files/"},
				AbortIncompleteMultipartUpload: lifecycle.AbortIncompleteMultipartUpload{DaysAfterInitiation: 8}}}
			if err := objects.SetBucketLifecycle(limit, bucket, rules); err != nil {
				slog.Warn("bucket lifecycle rules unavailable; relying on worker cleanup")
			}
			return nil
		}
		select {
		case <-limit.Done():
		case <-time.After(time.Second):
		}
	}
	return fmt.Errorf("private bucket initialization failed")
}

// work runs periodic cleanup. File cleanup needs storage; reconciliation of unreferenced objects runs every
// sixty passes and only touches objects older than a day.
func work(ctx context.Context, db *pgxpool.Pool) error {
	interval := time.Minute
	if value := os.Getenv("CLEANUP_INTERVAL"); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil || parsed < time.Second || parsed > time.Hour {
			return fmt.Errorf("CLEANUP_INTERVAL must be between 1s and 1h")
		}
		interval = parsed
	}
	objects, err := storageClient(os.Getenv("APP_ENV") == "development")
	if err != nil {
		return err
	}
	retention, err := lifecycleSettings()
	if err != nil {
		return err
	}
	janitor := &foundation.Janitor{DB: db, Objects: objects, Bucket: os.Getenv("S3_BUCKET"), OrphanAge: 24 * time.Hour,
		SnapshotRetention: retention.snapshot}
	// Expiry notices reach open chats immediately when Redis is configured; otherwise chats see them on their next sync.
	if value := os.Getenv("REDIS_URL"); value != "" {
		options, err := redis.ParseURL(value)
		if err != nil {
			return fmt.Errorf("invalid REDIS_URL")
		}
		cache := redis.NewClient(options)
		defer cache.Close()
		janitor.Notify = func(ctx context.Context, conversationID string) {
			foundation.PublishMessageChange(ctx, cache, conversationID)
		}
	}
	for pass := 0; ; pass++ {
		if _, err := db.Exec(ctx, `DELETE FROM device_sessions WHERE id IN (
            SELECT id FROM device_sessions WHERE expires_at<=now() ORDER BY expires_at LIMIT 500)`); err != nil && ctx.Err() == nil {
			slog.Warn("session cleanup failed")
		}
		if _, err := db.Exec(ctx, `DELETE FROM email_verifications WHERE token_hash IN (
            SELECT token_hash FROM email_verifications WHERE expires_at<=now() ORDER BY expires_at LIMIT 500)`); err != nil && ctx.Err() == nil {
			slog.Warn("verification cleanup failed")
		}
		step, cancel := context.WithTimeout(ctx, 5*time.Minute)
		if report, err := janitor.Sweep(step); err != nil && ctx.Err() == nil {
			slog.Warn("file cleanup failed")
		} else if report.Transfers+report.Expired+report.Purged > 0 {
			slog.Info("file cleanup", "transfers", report.Transfers, "expired", report.Expired, "purged", report.Purged)
		}
		if pass%60 == 0 {
			if report, err := janitor.Reconcile(step); err != nil && ctx.Err() == nil {
				slog.Warn("storage reconciliation failed")
			} else if report.Orphans+report.Uploads > 0 {
				slog.Info("storage reconciliation", "objects", report.Orphans, "uploads", report.Uploads)
			}
		}
		cancel()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(interval):
		}
	}
}

type retention struct{ file, snapshot time.Duration }

// lifecycleSettings reads FILE_RETENTION, the default and longest file lifetime, and SNAPSHOT_RETENTION, how long
// expired files stay restorable by administrators ("0" disables snapshots). Both use Go durations such as "720h".
func lifecycleSettings() (retention, error) {
	settings := retention{file: foundation.DefaultFileRetention, snapshot: foundation.DefaultFileRetention}
	if value := os.Getenv("FILE_RETENTION"); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil || parsed < time.Minute || parsed > 24*365*time.Hour {
			return settings, fmt.Errorf("FILE_RETENTION must be between 1m and 8760h")
		}
		settings.file = parsed
	}
	if value := os.Getenv("SNAPSHOT_RETENTION"); value != "" {
		parsed, err := time.ParseDuration(value)
		if err != nil || parsed < 0 || parsed > 24*365*time.Hour {
			return settings, fmt.Errorf("SNAPSHOT_RETENTION must be between 0 and 8760h")
		}
		settings.snapshot = parsed
	}
	return settings, nil
}
