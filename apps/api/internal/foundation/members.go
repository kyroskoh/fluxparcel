package foundation

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
)

type member struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
}

func (s *Server) memberRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/conversations/{id}/members", s.listMembers)
	mux.HandleFunc("PATCH /v1/conversations/{id}/members/{userId}", s.limit("member-admin", 60, s.changeMemberRole))
	mux.HandleFunc("DELETE /v1/conversations/{id}/members/{userId}", s.limit("member-admin", 60, s.removeMember))
	mux.HandleFunc("POST /v1/conversations/{id}/members/{userId}/ownership", s.limit("member-admin", 60, s.transferOwnership))
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	// The viewer's membership gates the list in the same statement. Groups hold at most 100 members.
	rows, err := s.DB.Query(r.Context(), `SELECT o.user_id::text,u.display_name,o.role
        FROM memberships m JOIN memberships o ON o.conversation_id=m.conversation_id JOIN users u ON u.id=o.user_id
        WHERE m.conversation_id=$1 AND m.user_id=$2
        ORDER BY CASE o.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.display_name,o.user_id LIMIT 200`, id, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	result, err := pgx.CollectRows(rows, pgx.RowToStructByPos[member])
	if err != nil {
		failure(w, r)
		return
	}
	if len(result) == 0 {
		missing(w, r)
		return
	}
	respond(w, 200, result)
}

// memberChange holds the locked state an administrative change is decided on.
type memberChange struct {
	tx                    pgx.Tx
	conversationID        string
	actorID, targetID     string
	actorRole, targetRole string
}

// lockMembers serializes changes with invitation redemption by locking the conversation row,
// then loads both roles. Missing groups, direct chats and non-members all read as not found.
func (s *Server) lockMembers(w http.ResponseWriter, r *http.Request) (*memberChange, account, bool) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return nil, user, false
	}
	id, target := r.PathValue("id"), r.PathValue("userId")
	if !uuidPattern.MatchString(id) || !uuidPattern.MatchString(target) {
		missing(w, r)
		return nil, user, false
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return nil, user, false
	}
	change := &memberChange{tx: tx, conversationID: id, actorID: user.ID, targetID: target}
	err = tx.QueryRow(ctx, `SELECT m.role FROM conversations c JOIN memberships m ON m.conversation_id=c.id
        WHERE c.id=$1 AND m.user_id=$2 AND c.kind='group' FOR UPDATE OF c`, id, user.ID).Scan(&change.actorRole)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT role FROM memberships WHERE conversation_id=$1 AND user_id=$2`, id, target).Scan(&change.targetRole)
	}
	if !chatResult(w, r, err) {
		_ = tx.Rollback(ctx)
		return nil, user, false
	}
	return change, user, true
}

// revokeIssuedInvites stops invitations from an account that no longer administers the group.
func (c *memberChange) revokeIssuedInvites(ctx context.Context) error {
	_, err := c.tx.Exec(ctx, `UPDATE group_invitations SET revoked_at=now()
        WHERE conversation_id=$1 AND issuer_id=$2 AND revoked_at IS NULL`, c.conversationID, c.targetID)
	return err
}

func (s *Server) changeMemberRole(w http.ResponseWriter, r *http.Request) {
	// Read the body before locking so a slow client cannot hold the conversation lock.
	var input struct{ Role string }
	if !readJSON(w, r, &input) {
		return
	}
	if input.Role != "admin" && input.Role != "member" {
		problem(w, r, 400, "invalid_role", "Choose the admin or member role.")
		return
	}
	change, _, ok := s.lockMembers(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	defer change.tx.Rollback(ctx)
	if change.actorRole != "owner" {
		problem(w, r, 403, "owner_required", "Only the group owner can change roles.")
		return
	}
	if change.targetRole == "owner" {
		problem(w, r, 409, "owner_role", "The owner's role cannot be changed.")
		return
	}
	var result member
	err := change.tx.QueryRow(ctx, `UPDATE memberships m SET role=$3 FROM users u
        WHERE u.id=m.user_id AND m.conversation_id=$1 AND m.user_id=$2
        RETURNING m.user_id::text,u.display_name,m.role`, change.conversationID, change.targetID, input.Role).
		Scan(&result.UserID, &result.DisplayName, &result.Role)
	if err == nil && input.Role == "member" && change.targetRole == "admin" {
		err = change.revokeIssuedInvites(ctx)
	}
	if err == nil {
		err = change.tx.Commit(ctx)
	}
	if err != nil {
		failure(w, r)
		return
	}
	s.notifyMessage(ctx, change.conversationID)
	respond(w, 200, result)
}

func (s *Server) removeMember(w http.ResponseWriter, r *http.Request) {
	change, _, ok := s.lockMembers(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	defer change.tx.Rollback(ctx)
	leaving := change.actorID == change.targetID
	switch {
	case leaving && change.actorRole == "owner":
		problem(w, r, 409, "owner_cannot_leave", "The owner cannot leave the group.")
		return
	case leaving:
	case change.actorRole == "owner":
	case change.actorRole == "admin" && change.targetRole == "member":
	default:
		problem(w, r, 403, "admin_required", "You cannot remove this member.")
		return
	}
	_, err := change.tx.Exec(ctx, `DELETE FROM memberships WHERE conversation_id=$1 AND user_id=$2`, change.conversationID, change.targetID)
	if err == nil && !leaving {
		// A removal blocks rejoining through any invitation, including ones issued before it.
		_, err = change.tx.Exec(ctx, `INSERT INTO group_removals(conversation_id,user_id,removed_by) VALUES ($1,$2,$3)
            ON CONFLICT (conversation_id,user_id) DO UPDATE SET removed_by=EXCLUDED.removed_by,removed_at=now()`,
			change.conversationID, change.targetID, change.actorID)
	}
	if err == nil {
		err = change.revokeIssuedInvites(ctx)
	}
	if err == nil {
		err = change.tx.Commit(ctx)
	}
	if err != nil {
		failure(w, r)
		return
	}
	// Open sockets recheck membership on this notice, so the removed account's live view closes.
	s.notifyMessage(ctx, change.conversationID)
	w.WriteHeader(204)
}

// transferOwnership hands the group to another member. The previous owner stays on as an admin,
// keeps the invitations they issued, and can then leave. Deleting the new owner's account deletes the group.
func (s *Server) transferOwnership(w http.ResponseWriter, r *http.Request) {
	change, _, ok := s.lockMembers(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	defer change.tx.Rollback(ctx)
	if change.actorRole != "owner" {
		problem(w, r, 403, "owner_required", "Only the group owner can transfer ownership.")
		return
	}
	if change.targetID == change.actorID {
		problem(w, r, 409, "already_owner", "You already own this group.")
		return
	}
	_, err := change.tx.Exec(ctx, `UPDATE memberships SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'admin' END
        WHERE conversation_id=$1 AND user_id IN ($2,$3)`, change.conversationID, change.targetID, change.actorID)
	if err == nil {
		_, err = change.tx.Exec(ctx, `UPDATE conversations SET owner_id=$2 WHERE id=$1`, change.conversationID, change.targetID)
	}
	var result member
	if err == nil {
		err = change.tx.QueryRow(ctx, `SELECT m.user_id::text,u.display_name,m.role FROM memberships m
            JOIN users u ON u.id=m.user_id WHERE m.conversation_id=$1 AND m.user_id=$2`,
			change.conversationID, change.targetID).Scan(&result.UserID, &result.DisplayName, &result.Role)
	}
	if err == nil {
		err = change.tx.Commit(ctx)
	}
	if err != nil {
		failure(w, r)
		return
	}
	s.notifyMessage(ctx, change.conversationID)
	respond(w, 200, result)
}

var errRemovedFromGroup = errors.New("removed from group")

func removedFromGroup(ctx context.Context, tx pgx.Tx, conversationID, userID string) error {
	var removed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM group_removals WHERE conversation_id=$1 AND user_id=$2)`,
		conversationID, userID).Scan(&removed); err != nil {
		return err
	}
	if removed {
		return errRemovedFromGroup
	}
	return nil
}
