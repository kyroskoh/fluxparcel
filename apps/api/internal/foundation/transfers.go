package foundation

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/minio/minio-go/v7"
)

const (
	transferPartSize  = 8 << 20
	maxTransferSize   = 2 << 30
	transferRetention = 7 * 24 * time.Hour
	fileRetention     = 30 * 24 * time.Hour
	// staleVerification lets a later completion take over from one that stopped mid-verification.
	staleVerification = "15 minutes"
)

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// partBuffers reuses part-sized buffers, so steady uploads do not allocate 8 MiB per request.
var partBuffers = sync.Pool{New: func() any {
	buffer := make([]byte, transferPartSize)
	return &buffer
}}

type transferView struct {
	ID              string    `json:"id"`
	ConversationID  string    `json:"conversationId"`
	ClientID        string    `json:"clientId"`
	Name            string    `json:"name"`
	Mime            string    `json:"mime"`
	Size            int64     `json:"size"`
	SHA256          string    `json:"sha256"`
	PartSize        int64     `json:"partSize"`
	PartCount       int       `json:"partCount"`
	State           string    `json:"state"`
	Parts           []int     `json:"parts"`
	VerifiedBytes   int64     `json:"verifiedBytes"`
	ExpiresAt       time.Time `json:"expiresAt"`
	FileID          string    `json:"fileId,omitempty"`
	MessageSequence int64     `json:"messageSequence,omitempty"`
}

type transferRecord struct {
	transferView
	objectKey, uploadID string
	sha                 []byte
	expired             bool
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func (s *Server) transferRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/transfers", s.limit("transfer-create", 60, s.createTransfer))
	mux.HandleFunc("GET /v1/transfers/{id}", s.getTransfer)
	mux.HandleFunc("PUT /v1/transfers/{id}/parts/{number}", s.limit("transfer-part", 600, s.uploadPart))
	mux.HandleFunc("POST /v1/transfers/{id}/complete", s.limit("transfer-complete", 60, s.completeTransfer))
	mux.HandleFunc("DELETE /v1/transfers/{id}", s.cancelTransfer)
	mux.HandleFunc("GET /v1/files/{id}/content", s.limit("file-download", 300, s.downloadFile))
}

func partLength(size, partSize int64, number int) int64 {
	return min(partSize, size-int64(number-1)*partSize)
}

// loadTransfer returns the sender's transfer only while the sender is still a member of its conversation,
// so revoked membership stops uploads, reconciliation and publication.
func loadTransfer(ctx context.Context, q querier, id, senderID string) (*transferRecord, error) {
	t := &transferRecord{}
	err := q.QueryRow(ctx, `SELECT t.id,t.conversation_id,t.client_id,t.name,t.mime,t.size,t.sha256,t.part_size,t.state,
            t.object_key,t.upload_id,t.expires_at,COALESCE(t.file_id::text,''),COALESCE(t.message_sequence,0),t.expires_at<=now()
        FROM transfers t JOIN memberships m ON m.conversation_id=t.conversation_id AND m.user_id=t.sender_id
        WHERE t.id=$1 AND t.sender_id=$2`, id, senderID).Scan(&t.ID, &t.ConversationID, &t.ClientID, &t.Name, &t.Mime,
		&t.Size, &t.sha, &t.PartSize, &t.State, &t.objectKey, &t.uploadID, &t.ExpiresAt, &t.FileID, &t.MessageSequence, &t.expired)
	if err != nil {
		return nil, err
	}
	t.SHA256 = hex.EncodeToString(t.sha)
	t.PartCount = int((t.Size + t.PartSize - 1) / t.PartSize)
	rows, err := q.Query(ctx, `SELECT part_number,size FROM transfer_parts WHERE transfer_id=$1 ORDER BY part_number`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	t.Parts = []int{}
	for rows.Next() {
		var number int
		var size int64
		if err := rows.Scan(&number, &size); err != nil {
			return nil, err
		}
		t.Parts = append(t.Parts, number)
		t.VerifiedBytes += size
	}
	return t, rows.Err()
}

func validFileName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > 255 || name == "." || name == ".." {
		return false
	}
	for _, r := range name {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (s *Server) createTransfer(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var input struct {
		ConversationID, ClientID, Name, Mime, SHA256 string
		Size                                         int64
	}
	if !readJSON(w, r, &input) {
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.SHA256 = strings.ToLower(input.SHA256)
	mediaType := "application/octet-stream"
	if input.Mime != "" {
		parsed, _, err := mime.ParseMediaType(input.Mime)
		if err != nil || len(parsed) > 255 || !strings.Contains(parsed, "/") {
			problem(w, r, 400, "invalid_file", "Enter a valid file type.")
			return
		}
		mediaType = parsed
	}
	if !uuidPattern.MatchString(input.ConversationID) || !uuidPattern.MatchString(input.ClientID) ||
		!validFileName(input.Name) || !sha256Hex.MatchString(input.SHA256) {
		problem(w, r, 400, "invalid_file", "Enter a file name of 1–255 characters, a client ID and a SHA-256 checksum.")
		return
	}
	if input.Size < 1 || input.Size > maxTransferSize {
		problem(w, r, 400, "file_too_large", "Choose a file of up to 2 GiB.")
		return
	}
	ctx := r.Context()
	var member bool
	if err := s.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE conversation_id=$1 AND user_id=$2)`,
		input.ConversationID, user.ID).Scan(&member); err != nil {
		failure(w, r)
		return
	}
	if !member {
		missing(w, r)
		return
	}
	sum, _ := hex.DecodeString(input.SHA256)
	// A retried request with the same client ID returns the existing transfer instead of starting another upload.
	existing := func() bool {
		var id string
		err := s.DB.QueryRow(ctx, `SELECT id FROM transfers WHERE sender_id=$1 AND client_id=$2`, user.ID, input.ClientID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return false
		}
		var t *transferRecord
		if err == nil {
			t, err = loadTransfer(ctx, s.DB, id, user.ID)
		}
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			missing(w, r)
		case err != nil:
			failure(w, r)
		case t.ConversationID != input.ConversationID || t.Size != input.Size || !bytes.Equal(t.sha, sum) || t.Name != input.Name:
			problem(w, r, 409, "transfer_conflict", "This client transfer ID is already in use.")
		default:
			respond(w, 200, t.transferView)
		}
		return true
	}
	if existing() {
		return
	}
	core := minio.Core{Client: s.Objects}
	key := "files/" + rand.Text()
	uploadID, err := core.NewMultipartUpload(ctx, s.Bucket, key, minio.PutObjectOptions{ContentType: "application/octet-stream"})
	if err != nil {
		problem(w, r, 503, "storage_unavailable", "File storage is temporarily unavailable.")
		return
	}
	var id string
	err = s.DB.QueryRow(ctx, `INSERT INTO transfers(sender_id,conversation_id,client_id,name,mime,size,sha256,part_size,
            object_key,upload_id,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+$11::interval)
        ON CONFLICT (sender_id,client_id) DO NOTHING RETURNING id`, user.ID, input.ConversationID, input.ClientID,
		input.Name, mediaType, input.Size, sum, transferPartSize, key, uploadID, transferRetention.String()).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		// A concurrent request created the transfer first; discard this upload and answer with that one.
		_ = core.AbortMultipartUpload(context.WithoutCancel(ctx), s.Bucket, key, uploadID)
		existing()
		return
	}
	var t *transferRecord
	if err == nil {
		t, err = loadTransfer(ctx, s.DB, id, user.ID)
	}
	if err != nil {
		failure(w, r)
		return
	}
	respond(w, 201, t.transferView)
}

func (s *Server) senderTransfer(w http.ResponseWriter, r *http.Request) (*transferRecord, account, bool) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return nil, user, false
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return nil, user, false
	}
	t, err := loadTransfer(r.Context(), s.DB, id, user.ID)
	if !chatResult(w, r, err) {
		return nil, user, false
	}
	return t, user, true
}

func (s *Server) getTransfer(w http.ResponseWriter, r *http.Request) {
	if t, _, ok := s.senderTransfer(w, r); ok {
		respond(w, 200, t.transferView)
	}
}

func transferClosed(w http.ResponseWriter, r *http.Request, t *transferRecord) bool {
	switch {
	case t.State == "verifying":
		w.Header().Set("Retry-After", "2")
		problem(w, r, 409, "transfer_verifying", "This file is being verified.")
	case t.State != "uploading":
		problem(w, r, 409, "transfer_closed", "This transfer is "+t.State+".")
	case t.expired:
		problem(w, r, 409, "transfer_expired", "This upload expired. Start it again.")
	default:
		return false
	}
	return true
}

// uploadPart verifies one bounded part against the client's SHA-256 before storing it. Storage checks the same
// digest again, and only verified parts are recorded, so completion never assembles unverified bytes.
func (s *Server) uploadPart(w http.ResponseWriter, r *http.Request) {
	// Drain an unread body, at most one part, before answering. Otherwise an early rejection closes the
	// connection mid-upload and the proxy reports a gateway error instead of the real response.
	defer func() { _, _ = io.Copy(io.Discard, io.LimitReader(r.Body, transferPartSize)) }()
	number, err := strconv.Atoi(r.PathValue("number"))
	want := strings.ToLower(r.Header.Get("X-Content-SHA256"))
	if err != nil || number < 1 || !sha256Hex.MatchString(want) {
		problem(w, r, 400, "invalid_part", "Send a part number and its SHA-256 checksum.")
		return
	}
	t, _, ok := s.senderTransfer(w, r)
	if !ok || transferClosed(w, r, t) {
		return
	}
	if number > t.PartCount {
		problem(w, r, 400, "invalid_part", "This transfer has "+strconv.Itoa(t.PartCount)+" parts.")
		return
	}
	expected := partLength(t.Size, t.PartSize, number)
	if r.ContentLength != expected {
		problem(w, r, 400, "invalid_part_size", "Send exactly "+strconv.FormatInt(expected, 10)+" bytes for this part.")
		return
	}
	select {
	case s.partSlots <- struct{}{}:
		defer func() { <-s.partSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		problem(w, r, 503, "transfers_busy", "Too many uploads are in progress. Try again shortly.")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(2 * time.Minute))
	pooled := partBuffers.Get().(*[]byte)
	defer partBuffers.Put(pooled)
	buffer := (*pooled)[:expected]
	body := http.MaxBytesReader(w, r.Body, expected)
	if _, err := io.ReadFull(body, buffer); err != nil {
		problem(w, r, 400, "invalid_part_size", "The part ended early.")
		return
	}
	digest := sha256.Sum256(buffer)
	if hex.EncodeToString(digest[:]) != want {
		problem(w, r, 422, "part_checksum_mismatch", "The part does not match its checksum. Send it again.")
		return
	}
	ctx := r.Context()
	part, err := minio.Core{Client: s.Objects}.PutObjectPart(ctx, s.Bucket, t.objectKey, t.uploadID, number,
		bytes.NewReader(buffer), expected, minio.PutObjectPartOptions{Sha256Hex: want})
	if err != nil {
		w.Header().Set("Retry-After", "2")
		problem(w, r, 503, "storage_unavailable", "File storage is temporarily unavailable.")
		return
	}
	_, err = s.DB.Exec(ctx, `INSERT INTO transfer_parts(transfer_id,part_number,size,sha256,etag) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (transfer_id,part_number) DO UPDATE SET size=EXCLUDED.size,sha256=EXCLUDED.sha256,etag=EXCLUDED.etag`,
		t.ID, number, expected, digest[:], part.ETag)
	if err != nil {
		failure(w, r)
		return
	}
	respond(w, 200, map[string]int64{"partNumber": int64(number), "size": expected})
}

// completeTransfer assembles the verified parts, hashes the stored object as a stream and publishes the file
// as a message only when the whole-file SHA-256 matches. Multipart ETags are never treated as checksums.
func (s *Server) completeTransfer(w http.ResponseWriter, r *http.Request) {
	t, user, ok := s.senderTransfer(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	if t.State == "completed" {
		respond(w, 200, t.transferView)
		return
	}
	if transferClosed(w, r, t) {
		return
	}
	if len(t.Parts) != t.PartCount {
		problem(w, r, 409, "parts_missing", "Upload all "+strconv.Itoa(t.PartCount)+" parts before completing.")
		return
	}
	tag, err := s.DB.Exec(ctx, `UPDATE transfers SET state='verifying',updated_at=now() WHERE id=$1
        AND (state='uploading' OR (state='verifying' AND updated_at<now()-interval '`+staleVerification+`'))`, t.ID)
	if err != nil {
		failure(w, r)
		return
	}
	if tag.RowsAffected() == 0 {
		w.Header().Set("Retry-After", "2")
		problem(w, r, 409, "transfer_verifying", "This file is being verified.")
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Minute))
	work := context.WithoutCancel(ctx)
	reopen := func() {
		_, _ = s.DB.Exec(work, `UPDATE transfers SET state='uploading',updated_at=now() WHERE id=$1 AND state='verifying'`, t.ID)
	}
	fail := func() {
		_, _ = s.DB.Exec(work, `UPDATE transfers SET state='failed',updated_at=now() WHERE id=$1 AND state='verifying'`, t.ID)
		_ = s.Objects.RemoveObject(work, s.Bucket, t.objectKey, minio.RemoveObjectOptions{})
	}
	parts := make([]minio.CompletePart, 0, t.PartCount)
	rows, err := s.DB.Query(ctx, `SELECT part_number,etag FROM transfer_parts WHERE transfer_id=$1 ORDER BY part_number`, t.ID)
	if err == nil {
		parts, err = pgx.CollectRows(rows, func(row pgx.CollectableRow) (minio.CompletePart, error) {
			var part minio.CompletePart
			return part, row.Scan(&part.PartNumber, &part.ETag)
		})
	}
	if err != nil {
		reopen()
		failure(w, r)
		return
	}
	if _, err := (minio.Core{Client: s.Objects}).CompleteMultipartUpload(work, s.Bucket, t.objectKey, t.uploadID, parts,
		minio.PutObjectOptions{ContentType: "application/octet-stream"}); err != nil {
		// A takeover after an interrupted completion finds the object already assembled.
		if info, statErr := s.Objects.StatObject(work, s.Bucket, t.objectKey, minio.StatObjectOptions{}); statErr != nil || info.Size != t.Size {
			reopen()
			w.Header().Set("Retry-After", "2")
			problem(w, r, 503, "storage_unavailable", "File storage is temporarily unavailable.")
			return
		}
	}
	object, err := s.Objects.GetObject(work, s.Bucket, t.objectKey, minio.GetObjectOptions{})
	hash := sha256.New()
	var hashed int64
	if err == nil {
		hashed, err = io.Copy(hash, object)
		object.Close()
	}
	if err != nil {
		reopen()
		w.Header().Set("Retry-After", "2")
		problem(w, r, 503, "storage_unavailable", "File storage is temporarily unavailable.")
		return
	}
	if hashed != t.Size || !bytes.Equal(hash.Sum(nil), t.sha) {
		fail()
		problem(w, r, 422, "integrity_failed", "The assembled file does not match its checksum. Upload it again.")
		return
	}
	published, err := s.publishFile(work, t, user)
	if errors.Is(err, pgx.ErrNoRows) {
		fail()
		missing(w, r)
		return
	}
	if err != nil {
		reopen()
		failure(w, r)
		return
	}
	s.notifyMessage(work, t.ConversationID)
	respond(w, 200, published.transferView)
}

// publishFile records the verified file and its message atomically. It locks the conversation like a text send,
// so sequences and versions stay ordered, and fails if the sender lost membership during verification.
func (s *Server) publishFile(ctx context.Context, t *transferRecord, user account) (*transferRecord, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var sequence, version int64
	err = tx.QueryRow(ctx, `SELECT c.next_sequence FROM conversations c JOIN memberships m ON m.conversation_id=c.id
        WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE OF c,m`, t.ConversationID, user.ID).Scan(&sequence)
	if err != nil {
		return nil, err
	}
	var state string
	if err = tx.QueryRow(ctx, `SELECT state FROM transfers WHERE id=$1 FOR UPDATE`, t.ID).Scan(&state); err != nil {
		return nil, err
	}
	if state != "verifying" {
		return nil, pgx.ErrNoRows
	}
	var fileID string
	err = tx.QueryRow(ctx, `INSERT INTO files(conversation_id,owner_id,object_key,name,mime,size,sha256,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now()+$8::interval) RETURNING id`, t.ConversationID, user.ID, t.objectKey,
		t.Name, t.Mime, t.Size, t.sha, fileRetention.String()).Scan(&fileID)
	if err == nil {
		err = tx.QueryRow(ctx, `UPDATE conversations SET next_sequence=next_sequence+1,message_version=message_version+1
            WHERE id=$1 RETURNING message_version`, t.ConversationID).Scan(&version)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO messages(conversation_id,sequence,version,sender_id,client_id,body,body_digest,file_id)
            VALUES ($1,$2,$3,$4,$5,'',$6,$7)`, t.ConversationID, sequence, version, user.ID, t.ClientID, digest(""), fileID)
	}
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		return nil, pgx.ErrNoRows
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE transfers SET state='completed',file_id=$2,message_sequence=$3,updated_at=now()
            WHERE id=$1`, t.ID, fileID, sequence)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	t.State, t.FileID, t.MessageSequence = "completed", fileID, sequence
	return t, nil
}

func (s *Server) cancelTransfer(w http.ResponseWriter, r *http.Request) {
	t, _, ok := s.senderTransfer(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tag, err := s.DB.Exec(ctx, `UPDATE transfers SET state='cancelled',updated_at=now() WHERE id=$1 AND state='uploading'`, t.ID)
	if err != nil {
		failure(w, r)
		return
	}
	if tag.RowsAffected() == 0 {
		switch t.State {
		case "completed":
			problem(w, r, 409, "transfer_completed", "This file was already sent. Delete its message to remove it.")
			return
		case "verifying":
			w.Header().Set("Retry-After", "2")
			problem(w, r, 409, "transfer_verifying", "This file is being verified.")
			return
		}
	} else {
		// Parts are discarded in the background; a failed abort leaves the upload to expiry cleanup.
		_ = minio.Core{Client: s.Objects}.AbortMultipartUpload(context.WithoutCancel(ctx), s.Bucket, t.objectKey, t.uploadID)
	}
	w.WriteHeader(204)
}

// downloadFile streams an authorized attachment with Range support. The SHA-256 is the strong validator, so a
// resumed download with If-Range never mixes bytes from a different object.
func (s *Server) downloadFile(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	var key, name string
	var sum []byte
	err := s.DB.QueryRow(r.Context(), `SELECT f.object_key,f.name,f.sha256 FROM files f
        JOIN messages m ON m.file_id=f.id AND m.deleted_at IS NULL
        JOIN memberships mb ON mb.conversation_id=f.conversation_id AND mb.user_id=$2
        WHERE f.id=$1 AND f.expires_at>now() AND f.scan_status<>'rejected'`, id, user.ID).Scan(&key, &name, &sum)
	if !chatResult(w, r, err) {
		return
	}
	object, err := s.Objects.GetObject(r.Context(), s.Bucket, key, minio.GetObjectOptions{})
	if err == nil {
		_, err = object.Stat()
	}
	if err != nil {
		w.Header().Set("Retry-After", "2")
		problem(w, r, 503, "storage_unavailable", "File storage is temporarily unavailable.")
		return
	}
	defer object.Close()
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Hour))
	checksum := hex.EncodeToString(sum)
	header := w.Header()
	header.Set("ETag", `"`+checksum+`"`)
	header.Set("X-Content-SHA256", checksum)
	header.Set("Content-Type", "application/octet-stream")
	header.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	header.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	header.Set("Cache-Control", "private, no-store")
	http.ServeContent(w, r, "", time.Time{}, object)
}
