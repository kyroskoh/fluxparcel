package foundation

import (
	"bytes"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type conversation struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Role   string `json:"role"`
	Kind   string `json:"kind"`
	Unread int64  `json:"unread"`
}

type message struct {
	Sequence int64       `json:"sequence"`
	Version  int64       `json:"version"`
	ClientID string      `json:"clientId"`
	SenderID string      `json:"senderId"`
	Sender   string      `json:"sender"`
	Body     string      `json:"body"`
	Created  time.Time   `json:"createdAt"`
	Edited   *time.Time  `json:"editedAt,omitempty"`
	Deleted  *time.Time  `json:"deletedAt,omitempty"`
	File     *attachment `json:"file,omitempty"`
}

// attachment is a published file. It is hidden once its message is deleted.
type attachment struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Mime       string    `json:"mime"`
	Size       int64     `json:"size"`
	SHA256     string    `json:"sha256"`
	ScanStatus string    `json:"scanStatus"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

// messageColumns reads a message aliased as "page" and its sender aliased as "u".
const messageColumns = `page.sequence,page.version,page.client_id,COALESCE(page.sender_id::text,''),
        COALESCE(u.display_name,'Deleted account'),page.body,page.created_at,page.edited_at,page.deleted_at,
        CASE WHEN page.deleted_at IS NULL THEN f.id::text END,f.name,f.mime,f.size,encode(f.sha256,'hex'),f.scan_status,f.expires_at`

// messageJoins adds each message's sender and attachment to a query that aliases messages as "page".
const messageJoins = ` LEFT JOIN users u ON u.id=page.sender_id LEFT JOIN files f ON f.id=page.file_id`

func scanMessage(row pgx.Row, item *message) error {
	var fileID, name, mime, checksum, scan *string
	var size *int64
	var expires *time.Time
	err := row.Scan(&item.Sequence, &item.Version, &item.ClientID, &item.SenderID, &item.Sender, &item.Body,
		&item.Created, &item.Edited, &item.Deleted, &fileID, &name, &mime, &size, &checksum, &scan, &expires)
	if err == nil && fileID != nil {
		item.File = &attachment{ID: *fileID, Name: *name, Mime: *mime, Size: *size, SHA256: *checksum,
			ScanStatus: *scan, ExpiresAt: *expires}
	}
	return err
}

type reader struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Sequence    int64  `json:"sequence"`
}

type receipts struct {
	Sharing bool     `json:"sharing"`
	Readers []reader `json:"readers"`
}

// maxReceiptReaders bounds the receipt response for large groups.
const maxReceiptReaders = 200

func (s *Server) chatRoutes(mux *http.ServeMux) {
	s.contactRoutes(mux)
	s.memberRoutes(mux)
	s.messageEditRoutes(mux)
	mux.HandleFunc("GET /v1/conversations", s.listConversations)
	mux.HandleFunc("POST /v1/conversations", s.limit("group-create", 20, s.createGroup))
	mux.HandleFunc("GET /v1/conversations/{id}/messages", s.listMessages)
	mux.HandleFunc("POST /v1/conversations/{id}/read", s.limit("read-cursor", 120, s.markConversationRead))
	mux.HandleFunc("GET /v1/conversations/{id}/receipts", s.listReceipts)
	mux.HandleFunc("POST /v1/conversations/{id}/messages", s.limit("message-send", 120, s.sendMessage))
	mux.HandleFunc("GET /v1/conversations/{id}/invitations", s.listGroupInvites)
	mux.HandleFunc("POST /v1/invitations", s.limit("invite-create", 30, s.createGroupInvite))
	mux.HandleFunc("POST /v1/invitations/inspect", s.limit("invite-inspect", 60, s.inspectGroupInvite))
	mux.HandleFunc("POST /v1/invitations/redeem", s.limit("invite-redeem", 30, s.redeemGroupInvite))
	mux.HandleFunc("DELETE /v1/invitations/{id}", s.revokeGroupInvite)
}

func missing(w http.ResponseWriter, r *http.Request) {
	problem(w, r, 404, "not_found", "This resource is unavailable.")
}

func chatResult(w http.ResponseWriter, r *http.Request, err error) bool {
	if errors.Is(err, pgx.ErrNoRows) {
		missing(w, r)
	} else if err != nil {
		failure(w, r)
	}
	return err == nil
}

func (s *Server) listConversations(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT c.id,COALESCE(peer.display_name,c.title),m.role,c.kind,
            (SELECT count(*) FROM messages unread WHERE unread.conversation_id=c.id
                AND unread.sequence>m.read_sequence AND unread.sender_id IS DISTINCT FROM m.user_id
                AND unread.deleted_at IS NULL)
        FROM memberships m JOIN conversations c ON c.id=m.conversation_id
        LEFT JOIN direct_pairs p ON p.conversation_id=c.id
        LEFT JOIN users peer ON peer.id=CASE WHEN p.first_user=m.user_id THEN p.second_user ELSE p.first_user END
        WHERE m.user_id=$1 ORDER BY c.created_at DESC,c.id`, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	groups, err := pgx.CollectRows(rows, pgx.RowToStructByPos[conversation])
	if err != nil {
		failure(w, r)
		return
	}
	if groups == nil {
		groups = []conversation{}
	}
	respond(w, 200, groups)
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	var input struct{ Title string }
	if !readJSON(w, r, &input) {
		return
	}
	title := strings.TrimSpace(input.Title)
	if !validDisplayName(title) {
		problem(w, r, 400, "invalid_title", "Enter a group name of 1–80 characters.")
		return
	}
	result := conversation{Title: title, Role: "owner", Kind: "group"}
	err := s.DB.QueryRow(r.Context(), `WITH created AS (
        INSERT INTO conversations(title,owner_id) VALUES ($1,$2) RETURNING id
    ) INSERT INTO memberships(conversation_id,user_id,role)
        SELECT id,$2,'owner' FROM created RETURNING conversation_id`, title, user.ID).Scan(&result.ID)
	if err != nil {
		failure(w, r)
		return
	}
	respond(w, 201, result)
}

func (s *Server) markConversationRead(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	var input struct {
		Sequence          int64
		ExpectedAccountID string
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.ExpectedAccountID != "" && input.ExpectedAccountID != user.ID {
		problem(w, r, 403, "account_mismatch", "Sign in with the account that opened this chat.")
		return
	}
	if input.Sequence < 1 {
		problem(w, r, 400, "invalid_cursor", "Enter a positive message sequence.")
		return
	}
	var acknowledged int64
	err := s.DB.QueryRow(r.Context(), `UPDATE memberships m SET read_sequence=GREATEST(m.read_sequence,$3)
        FROM conversations c WHERE m.conversation_id=c.id AND c.id=$1
          AND m.user_id=$2 AND $3 < c.next_sequence RETURNING m.read_sequence`,
		id, user.ID, input.Sequence).Scan(&acknowledged)
	if chatResult(w, r, err) {
		if user.ShareReadReceipts {
			// Wake other open chats so senders see the shared receipt without waiting for polling.
			s.notifyMessage(r.Context(), id)
		}
		respond(w, 200, map[string]int64{"sequence": acknowledged})
	}
}

// listReceipts returns the read cursors that other members share. Sharing is reciprocal:
// an account that does not share its own receipts sees none. Private cursors and unread
// counts are unaffected by the setting.
func (s *Server) listReceipts(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	// One statement checks membership and both sharing preferences on the same snapshot.
	rows, err := s.DB.Query(r.Context(), `SELECT viewer.share_read_receipts,
            COALESCE(other.user_id::text,''),COALESCE(other.display_name,''),COALESCE(other.read_sequence,0)
        FROM memberships m JOIN users viewer ON viewer.id=m.user_id
        LEFT JOIN LATERAL (
            SELECT o.user_id,u.display_name,o.read_sequence FROM memberships o JOIN users u ON u.id=o.user_id
            WHERE o.conversation_id=m.conversation_id AND o.user_id<>m.user_id AND o.read_sequence>0
              AND u.share_read_receipts AND viewer.share_read_receipts
            ORDER BY o.read_sequence DESC,o.user_id LIMIT $3
        ) other ON true
        WHERE m.conversation_id=$1 AND m.user_id=$2`, id, user.ID, maxReceiptReaders)
	if err != nil {
		failure(w, r)
		return
	}
	defer rows.Close()
	result := receipts{Readers: []reader{}}
	found := false
	for rows.Next() {
		found = true
		var item reader
		if err := rows.Scan(&result.Sharing, &item.UserID, &item.DisplayName, &item.Sequence); err != nil {
			failure(w, r)
			return
		}
		if item.UserID != "" {
			result.Readers = append(result.Readers, item)
		}
	}
	if rows.Err() != nil {
		failure(w, r)
		return
	}
	if !found {
		missing(w, r)
		return
	}
	respond(w, 200, result)
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	// "after" pages new messages by sequence; "changedSince" pages sends, edits and deletions by version.
	query := r.URL.Query()
	column, cursorText := "sequence", query.Get("after")
	if changed := query.Get("changedSince"); changed != "" {
		if cursorText != "" {
			problem(w, r, 400, "invalid_cursor", "Use either after or changedSince.")
			return
		}
		column, cursorText = "version", changed
	}
	var cursor int64
	if cursorText != "" {
		var err error
		cursor, err = strconv.ParseInt(cursorText, 10, 64)
		if err != nil || cursor < 0 {
			problem(w, r, 400, "invalid_cursor", "Invalid message cursor.")
			return
		}
	}
	// A single statement checks membership and reads the page on the same snapshot.
	rows, err := s.DB.Query(r.Context(), `SELECT `+messageColumns+`
        FROM memberships m LEFT JOIN LATERAL (
            SELECT * FROM messages WHERE conversation_id=m.conversation_id AND `+column+`>$3
            ORDER BY `+column+` LIMIT 100
        ) page ON true`+messageJoins+`
        WHERE m.conversation_id=$1 AND m.user_id=$2 ORDER BY page.`+column, id, user.ID, cursor)
	if err != nil {
		failure(w, r)
		return
	}
	defer rows.Close()
	result := make([]message, 0)
	found := false
	for rows.Next() {
		found = true
		if rows.RawValues()[0] == nil {
			continue
		}
		var item message
		if err := scanMessage(rows, &item); err != nil {
			failure(w, r)
			return
		}
		result = append(result, item)
	}
	if rows.Err() != nil {
		failure(w, r)
		return
	}
	if !found {
		missing(w, r)
		return
	}
	respond(w, 200, result)
}

func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	var input struct{ ClientID, Body, ExpectedSenderID string }
	if !readJSON(w, r, &input) {
		return
	}
	if input.ExpectedSenderID != "" && input.ExpectedSenderID != user.ID {
		problem(w, r, 403, "sender_mismatch", "Sign in with the account that queued this message.")
		return
	}
	input.Body = strings.TrimSpace(input.Body)
	if !uuidPattern.MatchString(input.ClientID) || input.Body == "" || utf8.RuneCountInString(input.Body) > 800 || strings.ContainsRune(input.Body, 0) {
		problem(w, r, 400, "invalid_message", "Enter a message of 1–800 characters with a valid client ID.")
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var sequence int64
	err = tx.QueryRow(ctx, `SELECT c.next_sequence FROM conversations c
        JOIN memberships m ON m.conversation_id=c.id WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE OF c,m`, id, user.ID).Scan(&sequence)
	if !chatResult(w, r, err) {
		return
	}
	var storedID string
	var storedDigest []byte
	item := message{ClientID: input.ClientID, SenderID: user.ID, Sender: user.DisplayName}
	err = tx.QueryRow(ctx, `SELECT conversation_id,sequence,version,body,body_digest,created_at,edited_at,deleted_at
        FROM messages WHERE sender_id=$1 AND client_id=$2`, user.ID, input.ClientID).
		Scan(&storedID, &item.Sequence, &item.Version, &item.Body, &storedDigest, &item.Created, &item.Edited, &item.Deleted)
	if err == nil {
		// Compare the original text, so a retry still succeeds after the message was edited or deleted.
		if storedID != id || !bytes.Equal(storedDigest, digest(input.Body)) {
			problem(w, r, 409, "message_conflict", "This client message ID is already in use.")
			return
		}
		respond(w, 200, item)
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		failure(w, r)
		return
	}
	item.Sequence, item.Body = sequence, input.Body
	if err = tx.QueryRow(ctx, `UPDATE conversations SET next_sequence=next_sequence+1,message_version=message_version+1
        WHERE id=$1 RETURNING message_version`, id).Scan(&item.Version); err != nil {
		failure(w, r)
		return
	}
	err = tx.QueryRow(ctx, `INSERT INTO messages(conversation_id,sequence,version,sender_id,client_id,body,body_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING created_at`,
		id, sequence, item.Version, user.ID, input.ClientID, input.Body, digest(input.Body)).Scan(&item.Created)
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		problem(w, r, 409, "message_conflict", "This client message ID is already in use.")
		return
	}
	if err != nil {
		failure(w, r)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		failure(w, r)
		return
	}
	s.notifyMessage(ctx, id)
	respond(w, 201, item)
}
