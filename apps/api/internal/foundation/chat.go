package foundation

import (
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
	Sequence int64     `json:"sequence"`
	ClientID string    `json:"clientId"`
	SenderID string    `json:"senderId"`
	Sender   string    `json:"sender"`
	Body     string    `json:"body"`
	Created  time.Time `json:"createdAt"`
}

func (s *Server) chatRoutes(mux *http.ServeMux) {
	s.contactRoutes(mux)
	mux.HandleFunc("GET /v1/conversations", s.listConversations)
	mux.HandleFunc("POST /v1/conversations", s.limit("group-create", 20, s.createGroup))
	mux.HandleFunc("GET /v1/conversations/{id}/messages", s.listMessages)
	mux.HandleFunc("POST /v1/conversations/{id}/read", s.limit("read-cursor", 120, s.markConversationRead))
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
                AND unread.sequence>m.read_sequence AND unread.sender_id IS DISTINCT FROM m.user_id)
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
		respond(w, 200, map[string]int64{"sequence": acknowledged})
	}
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
	var after int64
	if cursor := r.URL.Query().Get("after"); cursor != "" {
		var err error
		after, err = strconv.ParseInt(cursor, 10, 64)
		if err != nil || after < 0 {
			problem(w, r, 400, "invalid_cursor", "Invalid message cursor.")
			return
		}
	}
	// A single statement checks membership and reads the page on the same snapshot.
	rows, err := s.DB.Query(r.Context(), `SELECT page.sequence,page.client_id,
        COALESCE(page.sender_id::text,''),COALESCE(u.display_name,'Deleted account'),page.body,page.created_at
        FROM memberships m LEFT JOIN LATERAL (
            SELECT * FROM messages WHERE conversation_id=m.conversation_id AND sequence>$3
            ORDER BY sequence LIMIT 100
        ) page ON true LEFT JOIN users u ON u.id=page.sender_id
        WHERE m.conversation_id=$1 AND m.user_id=$2 ORDER BY page.sequence`, id, user.ID, after)
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
		if err := rows.Scan(&item.Sequence, &item.ClientID, &item.SenderID, &item.Sender, &item.Body, &item.Created); err != nil {
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
	item := message{ClientID: input.ClientID, SenderID: user.ID, Sender: user.DisplayName}
	err = tx.QueryRow(ctx, `SELECT conversation_id,sequence,body,created_at FROM messages WHERE sender_id=$1 AND client_id=$2`,
		user.ID, input.ClientID).Scan(&storedID, &item.Sequence, &item.Body, &item.Created)
	if err == nil {
		if storedID != id || item.Body != input.Body {
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
	err = tx.QueryRow(ctx, `INSERT INTO messages(conversation_id,sequence,sender_id,client_id,body)
        VALUES ($1,$2,$3,$4,$5) RETURNING created_at`, id, sequence, user.ID, input.ClientID, input.Body).Scan(&item.Created)
	var constraint *pgconn.PgError
	if errors.As(err, &constraint) && constraint.Code == "23505" {
		problem(w, r, 409, "message_conflict", "This client message ID is already in use.")
		return
	}
	if err != nil {
		failure(w, r)
		return
	}
	if _, err = tx.Exec(ctx, "UPDATE conversations SET next_sequence=next_sequence+1 WHERE id=$1", id); err != nil {
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
