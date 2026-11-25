package foundation

import (
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

func (s *Server) messageEditRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PATCH /v1/conversations/{id}/messages/{sequence}", s.limit("message-edit", 60, s.editMessage))
	mux.HandleFunc("DELETE /v1/conversations/{id}/messages/{sequence}", s.limit("message-edit", 60, s.deleteMessage))
}

// lockedMessage is the state an edit or deletion is decided on, read after locking the conversation row.
type lockedMessage struct {
	tx             pgx.Tx
	conversationID string
	sequence       int64
	actorID        string
	kind, role     string
	senderID       string
	body           string
	version        int64
	deleted        bool
	editable       bool
}

// lockMessage locks the conversation row, which also serializes sends, so versions stay strictly increasing.
// Unknown conversations, non-members and unknown messages all read as not found.
func (s *Server) lockMessage(w http.ResponseWriter, r *http.Request) (*lockedMessage, bool) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return nil, false
	}
	id := r.PathValue("id")
	sequence, err := strconv.ParseInt(r.PathValue("sequence"), 10, 64)
	if !uuidPattern.MatchString(id) || err != nil || sequence < 1 {
		missing(w, r)
		return nil, false
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return nil, false
	}
	locked := &lockedMessage{tx: tx, conversationID: id, sequence: sequence, actorID: user.ID}
	err = tx.QueryRow(ctx, `SELECT c.kind,m.role FROM conversations c JOIN memberships m ON m.conversation_id=c.id
        WHERE c.id=$1 AND m.user_id=$2 FOR UPDATE OF c`, id, user.ID).Scan(&locked.kind, &locked.role)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT COALESCE(sender_id::text,''),body,version,deleted_at IS NOT NULL,
            created_at>now()-interval '24 hours' FROM messages WHERE conversation_id=$1 AND sequence=$2`, id, sequence).
			Scan(&locked.senderID, &locked.body, &locked.version, &locked.deleted, &locked.editable)
	}
	if !chatResult(w, r, err) {
		_ = tx.Rollback(ctx)
		return nil, false
	}
	return locked, true
}

// nextVersion reserves the conversation's next message version.
func (m *lockedMessage) nextVersion(r *http.Request) (int64, error) {
	var version int64
	err := m.tx.QueryRow(r.Context(), `UPDATE conversations SET message_version=message_version+1
        WHERE id=$1 RETURNING message_version`, m.conversationID).Scan(&version)
	return version, err
}

func (s *Server) editMessage(w http.ResponseWriter, r *http.Request) {
	// Read the body before locking so a slow client cannot hold the conversation lock.
	var input struct {
		Body            string
		ExpectedVersion int64
	}
	if !readJSON(w, r, &input) {
		return
	}
	input.Body = strings.TrimSpace(input.Body)
	if input.Body == "" || utf8.RuneCountInString(input.Body) > 800 || strings.ContainsRune(input.Body, 0) {
		problem(w, r, 400, "invalid_message", "Enter a message of 1–800 characters.")
		return
	}
	locked, ok := s.lockMessage(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	defer locked.tx.Rollback(ctx)
	switch {
	case locked.senderID != locked.actorID:
		problem(w, r, 403, "sender_required", "Only the sender can edit this message.")
		return
	case locked.deleted:
		problem(w, r, 409, "message_deleted", "This message was deleted.")
		return
	case !locked.editable:
		problem(w, r, 403, "edit_window_closed", "Messages can be edited for 24 hours after sending.")
		return
	case input.ExpectedVersion != 0 && input.ExpectedVersion != locked.version:
		problem(w, r, 409, "stale_message", "This message changed on another device. Reload it and try again.")
		return
	}
	// An unchanged body keeps the version, so retried edits are idempotent.
	if input.Body != locked.body {
		version, err := locked.nextVersion(r)
		if err == nil {
			_, err = locked.tx.Exec(ctx, `UPDATE messages SET body=$3,version=$4,edited_at=now()
                WHERE conversation_id=$1 AND sequence=$2`, locked.conversationID, locked.sequence, input.Body, version)
		}
		if err != nil {
			failure(w, r)
			return
		}
	}
	var result message
	err := scanMessage(locked.tx.QueryRow(ctx, `SELECT `+messageColumns+` FROM messages page
        LEFT JOIN users u ON u.id=page.sender_id WHERE page.conversation_id=$1 AND page.sequence=$2`,
		locked.conversationID, locked.sequence), &result)
	if err == nil {
		err = locked.tx.Commit(ctx)
	}
	if err != nil {
		failure(w, r)
		return
	}
	if result.Version != locked.version {
		s.notifyMessage(ctx, locked.conversationID)
	}
	respond(w, 200, result)
}

func (s *Server) deleteMessage(w http.ResponseWriter, r *http.Request) {
	locked, ok := s.lockMessage(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	defer locked.tx.Rollback(ctx)
	if locked.deleted {
		w.WriteHeader(204)
		return
	}
	moderator := locked.kind == "group" && (locked.role == "owner" || locked.role == "admin")
	if locked.senderID != locked.actorID && !moderator {
		problem(w, r, 403, "delete_forbidden", "You cannot delete this message.")
		return
	}
	version, err := locked.nextVersion(r)
	if err == nil {
		// Deletion removes the stored text; copies recipients already saved are outside the server's reach.
		_, err = locked.tx.Exec(ctx, `UPDATE messages SET body='',deleted_at=now(),version=$3
            WHERE conversation_id=$1 AND sequence=$2`, locked.conversationID, locked.sequence, version)
	}
	if err == nil {
		err = locked.tx.Commit(ctx)
	}
	if err != nil {
		failure(w, r)
		return
	}
	s.notifyMessage(ctx, locked.conversationID)
	w.WriteHeader(204)
}
