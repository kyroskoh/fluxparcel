package foundation

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/redis/go-redis/v9"
)

type Server struct {
	// RateLimitScale multiplies every per-address limit. Values below 1 keep the defaults.
	RateLimitScale   int64
	liveSlots        chan struct{}
	DB               *pgxpool.Pool
	Cache            *redis.Client
	Objects          *minio.Client
	Bucket           string
	Origin           string
	TrustProxy       bool
	SecureCookies    bool
	SendVerification func(context.Context, string, string) error
	dummyHash        []byte
	passwordWork     chan struct{}
}

type requestIDKey struct{}

func (s *Server) scaledLimit(maximum int64) int64 {
	if s.RateLimitScale > 1 {
		return maximum * s.RateLimitScale
	}
	return maximum
}

func (s *Server) Handler() http.Handler {
	s.liveSlots = make(chan struct{}, 256)
	s.passwordWork = make(chan struct{}, 4)
	s.dummyHash = hashPassword("dummy-password-for-missing-users")
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, 200, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /v1/capabilities", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, 200, map[string]bool{"messaging": true, "transfers": false, "invitations": true, "webPush": false})
	})
	mux.HandleFunc("POST /v1/auth/register", s.limit("register", 24, s.boundPasswordWork(s.register)))
	mux.HandleFunc("POST /v1/auth/login", s.limit("login", 20, s.boundPasswordWork(s.login)))
	mux.HandleFunc("POST /v1/auth/refresh", s.limit("refresh", 90, s.refresh))
	mux.HandleFunc("POST /v1/auth/logout", s.logout)
	mux.HandleFunc("POST /v1/auth/verify", s.limit("verify", 30, s.verify))
	mux.HandleFunc("POST /v1/auth/verification", s.limit("verification", 8, s.resend))
	mux.HandleFunc("GET /v1/account", s.account)
	mux.HandleFunc("PATCH /v1/account", s.updateAccount)
	mux.HandleFunc("DELETE /v1/account", s.limit("delete-account", 24, s.boundPasswordWork(s.deleteAccount)))
	mux.HandleFunc("GET /v1/account/devices", s.devices)
	mux.HandleFunc("DELETE /v1/account/devices/{id}", s.revokeDevice)
	s.chatRoutes(mux)
	mux.HandleFunc("GET "+livePath, s.limit("live-open", 120, s.liveMessages))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		problem(w, r, 404, "not_found", "Endpoint unavailable.")
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := rand.Text()
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id))
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Origin") != s.Origin {
			problem(w, r, 403, "origin_denied", "Request origin denied.")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if s.DB.Ping(ctx) != nil || s.Cache.Ping(ctx).Err() != nil {
		problem(w, r, 503, "not_ready", "Backing services are unavailable.")
		return
	}
	exists, err := s.Objects.BucketExists(ctx, s.Bucket)
	if err != nil || !exists {
		problem(w, r, 503, "not_ready", "Storage is unavailable.")
		return
	}
	respond(w, 200, map[string]string{"status": "ready"})
}

const limitScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
return count
`

func (s *Server) limit(bucket string, maximum int64, next http.HandlerFunc) http.HandlerFunc {
	maximum = s.scaledLimit(maximum)
	return func(w http.ResponseWriter, r *http.Request) {
		ip, _, _ := net.SplitHostPort(r.RemoteAddr)
		if s.TrustProxy {
			if forwarded := net.ParseIP(r.Header.Get("X-Real-IP")); forwarded != nil {
				ip = forwarded.String()
			}
		}
		key := "fluxparcel:auth:" + bucket + ":" + ip
		count, err := s.Cache.Eval(r.Context(), limitScript, []string{key}, 60000).Int64()
		if err != nil {
			problem(w, r, 503, "rate_limit_unavailable", "Try again shortly.")
			return
		}
		if count > maximum {
			w.Header().Set("Retry-After", "60")
			problem(w, r, 429, "rate_limited", "Too many requests. Try again in a minute.")
			return
		}
		next(w, r)
	}
}

func respond(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func problem(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	id, _ := r.Context().Value(requestIDKey{}).(string)
	respond(w, status, map[string]string{"code": code, "message": message, "requestId": id})
}

func failure(w http.ResponseWriter, r *http.Request) {
	slog.Error("request failed", "request_id", r.Context().Value(requestIDKey{}))
	problem(w, r, 500, "internal_error", "The request could not be completed.")
}

func readJSON(w http.ResponseWriter, r *http.Request, payload any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(payload); err != nil || decoder.Decode(new(any)) != io.EOF {
		problem(w, r, 400, "invalid_request", "Invalid request body.")
		return false
	}
	return true
}

func token() string {
	data := make([]byte, 32)
	rand.Read(data)
	return base64.RawURLEncoding.EncodeToString(data)
}

func digest(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func (s *Server) boundPasswordWork(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.passwordWork <- struct{}{}:
			defer func() { <-s.passwordWork }()
			next(w, r)
		default:
			w.Header().Set("Retry-After", "2")
			problem(w, r, 503, "authentication_busy", "Too many authentication requests. Try again shortly.")
		}
	}
}
