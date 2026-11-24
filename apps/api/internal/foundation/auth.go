package foundation

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/argon2"
)

const accessTTL = 15 * time.Minute
const refreshTTL = 30 * 24 * time.Hour

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)
var uuidPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type account struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Verified    bool   `json:"verified"`
	// ShareReadReceipts lets other members see this account's read cursor. It is off by default.
	ShareReadReceipts bool `json:"shareReadReceipts"`
}

func hashPassword(password string) []byte {
	salt := make([]byte, 16)
	rand.Read(salt)
	return append(salt, argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)...)
}

func passwordMatches(password string, stored []byte) bool {
	if len(stored) != 48 || len(password) > 256 {
		return false
	}
	key := argon2.IDKey([]byte(password), stored[:16], 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(key, stored[16:]) == 1
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	var p struct{ Email, Username, DisplayName, Password string }
	if !readJSON(w, r, &p) {
		return
	}
	p.Email = strings.ToLower(strings.TrimSpace(p.Email))
	p.Username = strings.ToLower(strings.TrimSpace(p.Username))
	p.DisplayName = strings.TrimSpace(p.DisplayName)
	address, err := mail.ParseAddress(p.Email)
	if err != nil || address.Address != p.Email || len(p.Email) > 254 || !usernamePattern.MatchString(p.Username) ||
		!validDisplayName(p.DisplayName) || utf8.RuneCountInString(p.Password) < 12 || len(p.Password) > 256 {
		problem(w, r, 400, "invalid_registration", "Enter a valid email, a username of 3–32 letters, digits or underscores, a name and a password of at least 12 characters.")
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	user := account{Email: p.Email, Username: p.Username, DisplayName: p.DisplayName}
	err = tx.QueryRow(ctx, "INSERT INTO users (email,username,display_name,password_hash) VALUES ($1,$2,$3,$4) RETURNING id",
		p.Email, p.Username, p.DisplayName, hashPassword(p.Password)).Scan(&user.ID)
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		problem(w, r, 409, "account_conflict", "An account already uses those details.")
		return
	}
	if err != nil {
		failure(w, r)
		return
	}
	verification, access, refresh := token(), token(), token()
	if _, err = tx.Exec(ctx, "INSERT INTO email_verifications VALUES ($1,$2,now()+interval '24 hours')", digest(verification), user.ID); err != nil {
		failure(w, r)
		return
	}
	if _, err = tx.Exec(ctx, insertSession, user.ID, digest(access), digest(refresh)); err != nil {
		failure(w, r)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, r)
		return
	}
	if err := s.SendVerification(ctx, user.Email, verification); err != nil {
		slog.Warn("verification email unavailable", "request_id", ctx.Value(requestIDKey{}))
	}
	s.setCookies(w, access, refresh)
	respond(w, 201, user)
}

const insertSession = `INSERT INTO device_sessions (user_id,access_hash,refresh_hash,access_expires_at,expires_at)
VALUES ($1,$2,$3,now()+interval '15 minutes',now()+interval '30 days')`

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var p struct{ Email, Password string }
	if !readJSON(w, r, &p) {
		return
	}
	var user account
	var password []byte
	err := s.DB.QueryRow(r.Context(), `SELECT id,email,username,display_name,verified_at IS NOT NULL,share_read_receipts,password_hash
        FROM users WHERE email=$1`,
		strings.ToLower(strings.TrimSpace(p.Email))).Scan(&user.ID, &user.Email, &user.Username, &user.DisplayName, &user.Verified, &user.ShareReadReceipts, &password)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		failure(w, r)
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		password = s.dummyHash
	}
	if matches := passwordMatches(p.Password, password); err != nil || !matches {
		problem(w, r, 401, "invalid_credentials", "Email or password is incorrect.")
		return
	}
	access, refresh := token(), token()
	if _, err := s.DB.Exec(r.Context(), insertSession, user.ID, digest(access), digest(refresh)); err != nil {
		failure(w, r)
		return
	}
	s.setCookies(w, access, refresh)
	respond(w, 200, user)
}

func cookieValue(r *http.Request, name string) string {
	cookie, err := r.Cookie(name)
	if err != nil || len(cookie.Value) != 43 {
		return ""
	}
	return cookie.Value
}

func (s *Server) setCookies(w http.ResponseWriter, access, refresh string) {
	s.writeCookie(w, "rv_access", access, "/v1", int(accessTTL.Seconds()))
	s.writeCookie(w, "rv_refresh", refresh, "/v1/auth", int(refreshTTL.Seconds()))
}

func (s *Server) clearCookies(w http.ResponseWriter) {
	s.writeCookie(w, "rv_access", "", "/v1", -1)
	s.writeCookie(w, "rv_refresh", "", "/v1/auth", -1)
}

func (s *Server) writeCookie(w http.ResponseWriter, name, value, path string, age int) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: path, MaxAge: age,
		HttpOnly: true, Secure: s.SecureCookies, SameSite: http.SameSiteStrictMode})
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	access, refresh := token(), token()
	var id string
	err := s.DB.QueryRow(r.Context(), `UPDATE device_sessions SET access_hash=$2,refresh_hash=$3,
        access_expires_at=now()+interval '15 minutes',expires_at=now()+interval '30 days',last_seen_at=now()
        WHERE refresh_hash=$1 AND expires_at>now() RETURNING id`,
		digest(cookieValue(r, "rv_refresh")), digest(access), digest(refresh)).Scan(&id)
	if !authResult(w, r, err) {
		return
	}
	s.setCookies(w, access, refresh)
	w.WriteHeader(204)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.Exec(r.Context(), "DELETE FROM device_sessions WHERE access_hash=$1 OR refresh_hash=$2",
		digest(cookieValue(r, "rv_access")), digest(cookieValue(r, "rv_refresh"))); err != nil {
		failure(w, r)
		return
	}
	s.clearCookies(w)
	w.WriteHeader(204)
}

func (s *Server) authenticate(w http.ResponseWriter, r *http.Request) (account, string, bool) {
	var user account
	var device string
	err := s.DB.QueryRow(r.Context(), `SELECT u.id,u.email,u.username,u.display_name,u.verified_at IS NOT NULL,u.share_read_receipts,d.id
        FROM device_sessions d JOIN users u ON u.id=d.user_id
        WHERE d.access_hash=$1 AND d.access_expires_at>now() AND d.expires_at>now()`,
		digest(cookieValue(r, "rv_access"))).Scan(&user.ID, &user.Email, &user.Username, &user.DisplayName, &user.Verified, &user.ShareReadReceipts, &device)
	return user, device, authResult(w, r, err)
}

func authResult(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, r, 401, "session_required", "Sign in to continue.")
	} else if err != nil {
		failure(w, r)
	}
	return err == nil
}

func (s *Server) verify(w http.ResponseWriter, r *http.Request) {
	var p struct{ Token string }
	if !readJSON(w, r, &p) {
		return
	}
	var id string
	err := s.DB.QueryRow(r.Context(), `WITH claimed AS (
        DELETE FROM email_verifications WHERE token_hash=$1 AND expires_at>now() RETURNING user_id
    ) UPDATE users SET verified_at=now() FROM claimed WHERE users.id=claimed.user_id RETURNING users.id`,
		digest(p.Token)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		problem(w, r, 400, "invalid_verification", "This verification link is invalid or has expired.")
		return
	}
	if err != nil {
		failure(w, r)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) resend(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if user.Verified {
		w.WriteHeader(204)
		return
	}
	verification := token()
	_, err := s.DB.Exec(r.Context(), `INSERT INTO email_verifications (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '24 hours')
        ON CONFLICT (user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at`, digest(verification), user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	if err := s.SendVerification(r.Context(), user.Email, verification); err != nil {
		problem(w, r, 503, "verification_unavailable", "Email delivery is temporarily unavailable.")
		return
	}
	w.WriteHeader(204)
}

func validDisplayName(name string) bool {
	return !strings.ContainsRune(name, 0) && utf8.RuneCountInString(name) >= 1 && utf8.RuneCountInString(name) <= 80
}

func (s *Server) account(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if ok {
		respond(w, 200, user)
	}
}

func (s *Server) updateAccount(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var p struct {
		DisplayName       *string
		ShareReadReceipts *bool
	}
	if !readJSON(w, r, &p) {
		return
	}
	if p.DisplayName == nil && p.ShareReadReceipts == nil {
		problem(w, r, 400, "invalid_request", "Invalid request body.")
		return
	}
	if p.DisplayName != nil {
		name := strings.TrimSpace(*p.DisplayName)
		if !validDisplayName(name) {
			problem(w, r, 400, "invalid_name", "Enter a display name of 1–80 characters.")
			return
		}
		p.DisplayName = &name
	}
	// Omitted fields keep their stored values so concurrent edits from other devices are not overwritten.
	err := s.DB.QueryRow(r.Context(), `UPDATE users SET display_name=COALESCE($2,display_name),
        share_read_receipts=COALESCE($3,share_read_receipts) WHERE id=$1
        RETURNING display_name,share_read_receipts`, user.ID, p.DisplayName, p.ShareReadReceipts).
		Scan(&user.DisplayName, &user.ShareReadReceipts)
	if err != nil {
		failure(w, r)
		return
	}
	respond(w, 200, user)
}

func (s *Server) deleteAccount(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var p struct{ Password string }
	if !readJSON(w, r, &p) {
		return
	}
	var password []byte
	if err := s.DB.QueryRow(r.Context(), "SELECT password_hash FROM users WHERE id=$1", user.ID).Scan(&password); err != nil {
		failure(w, r)
		return
	}
	if !passwordMatches(p.Password, password) {
		problem(w, r, 403, "incorrect_password", "The password is incorrect.")
		return
	}
	if _, err := s.DB.Exec(r.Context(), "DELETE FROM users WHERE id=$1", user.ID); err != nil {
		failure(w, r)
		return
	}
	s.clearCookies(w)
	w.WriteHeader(204)
}

func (s *Server) devices(w http.ResponseWriter, r *http.Request) {
	user, current, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	type device struct {
		ID       string    `json:"id"`
		Created  time.Time `json:"createdAt"`
		LastSeen time.Time `json:"lastSeenAt"`
		Current  bool      `json:"current"`
	}
	rows, err := s.DB.Query(r.Context(), `SELECT id,created_at,last_seen_at
        FROM device_sessions WHERE user_id=$1 AND expires_at>now() ORDER BY id=$2 DESC,created_at DESC`, user.ID, current)
	if err != nil {
		failure(w, r)
		return
	}
	defer rows.Close()
	result := make([]device, 0)
	for rows.Next() {
		var d device
		if err := rows.Scan(&d.ID, &d.Created, &d.LastSeen); err != nil {
			failure(w, r)
			return
		}
		d.Current = d.ID == current
		result = append(result, d)
	}
	if rows.Err() != nil {
		failure(w, r)
		return
	}
	respond(w, 200, result)
}

func (s *Server) revokeDevice(w http.ResponseWriter, r *http.Request) {
	user, current, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		problem(w, r, 404, "not_found", "Device session not found.")
		return
	}
	removed, err := s.DB.Exec(r.Context(), "DELETE FROM device_sessions WHERE id=$1 AND user_id=$2", id, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	if removed.RowsAffected() == 0 {
		problem(w, r, 404, "not_found", "Device session not found.")
		return
	}
	if id == current {
		s.clearCookies(w)
	}
	w.WriteHeader(204)
}
