package foundation

import (
	"errors"
	"net/http"
	"time"
)

const availableInvite = "i.revoked_at IS NULL AND i.expires_at>now() AND i.used_count<i.max_uses"

type invitePreview struct {
	Title   string    `json:"title"`
	Issuer  string    `json:"issuer"`
	Expires time.Time `json:"expiresAt"`
}

func (s *Server) createGroupInvite(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !user.Verified {
		problem(w, r, 403, "verify_email", "Verify your email before creating invitations.")
		return
	}
	var p struct {
		ConversationID        string
		MaxUses, ExpiresHours int
	}
	if !readJSON(w, r, &p) {
		return
	}
	if p.MaxUses == 0 {
		p.MaxUses = 1
	}
	if p.ExpiresHours == 0 {
		p.ExpiresHours = 24
	}
	if !uuidPattern.MatchString(p.ConversationID) || p.MaxUses < 1 || p.MaxUses > 100 || p.ExpiresHours < 1 || p.ExpiresHours > 24 {
		problem(w, r, 400, "invalid_invite", "Choose 1–100 uses and an expiry of 1–24 hours.")
		return
	}
	secret := token()
	var id string
	err := s.DB.QueryRow(r.Context(), `INSERT INTO group_invitations(conversation_id,issuer_id,token_hash,expires_at,max_uses)
        SELECT conversation_id,user_id,$3,now()+$4::int*interval '1 hour',$5 FROM memberships
        WHERE conversation_id=$1 AND user_id=$2 AND role IN ('owner','admin') RETURNING id`,
		p.ConversationID, user.ID, digest(secret), p.ExpiresHours, p.MaxUses).Scan(&id)
	if !chatResult(w, r, err) {
		return
	}
	respond(w, 201, map[string]string{"id": id, "url": s.Origin + "/i#" + secret})
}

func readInviteToken(w http.ResponseWriter, r *http.Request) string {
	var p struct{ Token string }
	if !readJSON(w, r, &p) {
		return ""
	}
	if len(p.Token) != 43 {
		missing(w, r)
		return ""
	}
	return p.Token
}

func (s *Server) inspectGroupInvite(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.authenticate(w, r); !ok {
		return
	}
	secret := readInviteToken(w, r)
	if secret == "" {
		return
	}
	var result invitePreview
	err := s.DB.QueryRow(r.Context(), `SELECT c.title,u.display_name,i.expires_at FROM group_invitations i
        JOIN conversations c ON c.id=i.conversation_id JOIN users u ON u.id=i.issuer_id
        WHERE i.token_hash=$1 AND `+availableInvite, digest(secret)).Scan(&result.Title, &result.Issuer, &result.Expires)
	if chatResult(w, r, err) {
		respond(w, 200, result)
	}
}

func (s *Server) redeemGroupInvite(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	secret := readInviteToken(w, r)
	if secret == "" {
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var group, id string
	hash := digest(secret)
	err = tx.QueryRow(ctx, `SELECT c.id FROM conversations c JOIN group_invitations i ON i.conversation_id=c.id
        WHERE i.token_hash=$1 FOR UPDATE OF c`, hash).Scan(&group)
	if !chatResult(w, r, err) {
		return
	}
	var member bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM memberships WHERE conversation_id=$1 AND user_id=$2)`, group, user.ID).Scan(&member); err != nil {
		failure(w, r)
		return
	}
	if member {
		respond(w, 200, map[string]string{"conversationId": group})
		return
	}
	if err := removedFromGroup(ctx, tx, group, user.ID); errors.Is(err, errRemovedFromGroup) {
		problem(w, r, 403, "removed_from_group", "A group admin removed you from this group.")
		return
	} else if err != nil {
		failure(w, r)
		return
	}
	err = tx.QueryRow(ctx, `SELECT i.id FROM group_invitations i WHERE i.token_hash=$1 AND `+availableInvite+` FOR UPDATE OF i`, hash).Scan(&id)
	if !chatResult(w, r, err) {
		return
	}
	var count int
	if err := tx.QueryRow(ctx, "SELECT count(*) FROM memberships WHERE conversation_id=$1", group).Scan(&count); err != nil {
		failure(w, r)
		return
	}
	if count >= 100 {
		problem(w, r, 409, "group_full", "This group has reached its member limit.")
		return
	}
	if _, err := tx.Exec(ctx, `INSERT INTO memberships (conversation_id,user_id,role) VALUES ($1,$2,'member')`, group, user.ID); err != nil {
		failure(w, r)
		return
	}
	if _, err := tx.Exec(ctx, "UPDATE group_invitations SET used_count=used_count+1 WHERE id=$1", id); err != nil {
		failure(w, r)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, r)
		return
	}
	respond(w, 200, map[string]string{"conversationId": group})
}

func (s *Server) revokeGroupInvite(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	var revoked string
	err := s.DB.QueryRow(r.Context(), `UPDATE group_invitations i SET revoked_at=COALESCE(revoked_at,now())
        FROM memberships m WHERE m.conversation_id=i.conversation_id AND m.user_id=$2
        AND m.role IN ('owner','admin') AND i.id=$1 RETURNING i.id`, id, user.ID).Scan(&revoked)
	if chatResult(w, r, err) {
		w.WriteHeader(204)
	}
}

type inviteStatus struct {
	ID      string    `json:"id"`
	Expires time.Time `json:"expiresAt"`
	MaxUses int       `json:"maxUses"`
	Used    int       `json:"usedCount"`
}

func (s *Server) listGroupInvites(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT page.id,page.expires_at,page.max_uses,page.used_count FROM memberships m
        LEFT JOIN LATERAL (SELECT i.* FROM group_invitations i WHERE i.conversation_id=m.conversation_id
            AND `+availableInvite+` ORDER BY i.expires_at DESC LIMIT 100) page ON true
        WHERE m.conversation_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin')`, id, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	defer rows.Close()
	result := make([]inviteStatus, 0)
	found := false
	for rows.Next() {
		found = true
		if rows.RawValues()[0] == nil {
			continue
		}
		var item inviteStatus
		if err := rows.Scan(&item.ID, &item.Expires, &item.MaxUses, &item.Used); err != nil {
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
