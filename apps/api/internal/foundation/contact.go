package foundation

import (
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

func (s *Server) contactRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/contact-invitations", s.listContactInvites)
	mux.HandleFunc("POST /v1/contact-invitations", s.limit("contact-invite", 20, s.createContactInvite))
	mux.HandleFunc("POST /v1/contact-invitations/inspect", s.limit("contact-inspect", 60, s.inspectContactInvite))
	mux.HandleFunc("POST /v1/contact-invitations/redeem", s.limit("contact-redeem", 30, s.redeemContactInvite))
	mux.HandleFunc("DELETE /v1/contact-invitations/{id}", s.revokeContactInvite)
	mux.HandleFunc("GET /v1/contact-requests", s.listContactRequests)
	mux.HandleFunc("POST /v1/contact-requests/{id}/decision", s.limit("contact-decision", 60, s.decideContactRequest))
}

func (s *Server) createContactInvite(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	if !user.Verified {
		problem(w, r, 403, "verify_email", "Verify your email before creating invitations.")
		return
	}
	var p struct{ MaxUses, ExpiresMinutes int }
	if !readJSON(w, r, &p) {
		return
	}
	if p.MaxUses == 0 {
		p.MaxUses = 1
	}
	if p.ExpiresMinutes == 0 {
		p.ExpiresMinutes = 15
	}
	if p.MaxUses < 1 || p.MaxUses > 20 || p.ExpiresMinutes < 1 || p.ExpiresMinutes > 60 {
		problem(w, r, 400, "invalid_invite", "Choose 1–20 uses and an expiry of 1–60 minutes.")
		return
	}
	secret := token()
	var id string
	err := s.DB.QueryRow(r.Context(), `INSERT INTO contact_invitations(issuer_id,token_hash,expires_at,max_uses)
        VALUES ($1,$2,now()+$3::int*interval '1 minute',$4) RETURNING id`,
		user.ID, digest(secret), p.ExpiresMinutes, p.MaxUses).Scan(&id)
	if err != nil {
		failure(w, r)
		return
	}
	respond(w, 201, map[string]string{"id": id, "url": s.Origin + "/i#contact_" + secret})
}

func (s *Server) listContactInvites(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT i.id,i.expires_at,i.max_uses,i.used_count FROM contact_invitations i
        WHERE issuer_id=$1 AND `+availableInvite+` ORDER BY expires_at DESC LIMIT 100`, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	result, err := pgx.CollectRows(rows, pgx.RowToStructByPos[inviteStatus])
	if err != nil {
		failure(w, r)
		return
	}
	if result == nil {
		result = []inviteStatus{}
	}
	respond(w, 200, result)
}

func (s *Server) inspectContactInvite(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	secret := readInviteToken(w, r)
	if secret == "" {
		return
	}
	var result invitePreview
	err := s.DB.QueryRow(r.Context(), `SELECT u.display_name,i.expires_at FROM contact_invitations i JOIN users u ON u.id=i.issuer_id
        WHERE i.token_hash=$1 AND i.issuer_id<>$2 AND `+availableInvite, digest(secret), user.ID).Scan(&result.Issuer, &result.Expires)
	if chatResult(w, r, err) {
		respond(w, 200, result)
	}
}

func (s *Server) redeemContactInvite(w http.ResponseWriter, r *http.Request) {
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
	var invite, issuer string
	hash := digest(secret)
	err = tx.QueryRow(ctx, `SELECT issuer_id FROM contact_invitations WHERE token_hash=$1 AND issuer_id<>$2`,
		hash, user.ID).Scan(&issuer)
	if !chatResult(w, r, err) {
		return
	}
	locked, err := tx.Exec(ctx, "SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR KEY SHARE", issuer, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	if locked.RowsAffected() != 2 {
		missing(w, r)
		return
	}

	var available bool
	err = tx.QueryRow(ctx, `SELECT i.id,(`+availableInvite+`) FROM contact_invitations i
		WHERE i.token_hash=$1 FOR UPDATE OF i`, hash).Scan(&invite, &available)
	if !chatResult(w, r, err) {
		return
	}
	if !available {
		var alreadyUsed bool
		err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM contact_requests
			WHERE invitation_id=$1 AND requester_id=$2)`, invite, user.ID).Scan(&alreadyUsed)
		if err != nil {
			failure(w, r)
		} else if alreadyUsed {
			w.WriteHeader(204)
		} else {
			missing(w, r)
		}
		return
	}
	added, err := tx.Exec(ctx, `INSERT INTO contact_requests(issuer_id,requester_id,invitation_id) VALUES ($1,$2,$3)
		ON CONFLICT (issuer_id,requester_id) DO NOTHING`, issuer, user.ID, invite)
	if err != nil {
		failure(w, r)
		return
	}
	if added.RowsAffected() > 0 {
		if _, err := tx.Exec(ctx, "UPDATE contact_invitations SET used_count=used_count+1 WHERE id=$1", invite); err != nil {
			failure(w, r)
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, r)
		return
	}
	w.WriteHeader(204)
}

func (s *Server) revokeContactInvite(w http.ResponseWriter, r *http.Request) {
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
	err := s.DB.QueryRow(r.Context(), `UPDATE contact_invitations SET revoked_at=COALESCE(revoked_at,now())
        WHERE id=$1 AND issuer_id=$2 RETURNING id`, id, user.ID).Scan(&revoked)
	if chatResult(w, r, err) {
		w.WriteHeader(204)
	}
}

type contactRequest struct {
	ID             string    `json:"id"`
	Name           string    `json:"name"`
	Incoming       bool      `json:"incoming"`
	Status         string    `json:"status"`
	ConversationID string    `json:"conversationId"`
	CreatedAt      time.Time `json:"createdAt"`
}

func (s *Server) listContactRequests(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT r.id,u.display_name,r.issuer_id=$1,r.status,
        COALESCE(p.conversation_id::text,''),r.created_at FROM contact_requests r
        JOIN users u ON u.id=CASE WHEN r.issuer_id=$1 THEN r.requester_id ELSE r.issuer_id END
        LEFT JOIN direct_pairs p ON p.first_user=LEAST(r.issuer_id,r.requester_id)
            AND p.second_user=GREATEST(r.issuer_id,r.requester_id) AND r.status='approved'
        WHERE r.issuer_id=$1 OR r.requester_id=$1
        ORDER BY (r.status='pending') DESC,r.created_at DESC,r.id LIMIT 100`, user.ID)
	if err != nil {
		failure(w, r)
		return
	}
	result, err := pgx.CollectRows(rows, pgx.RowToStructByPos[contactRequest])
	if err != nil {
		failure(w, r)
		return
	}
	if result == nil {
		result = []contactRequest{}
	}
	respond(w, 200, result)
}

func (s *Server) decideContactRequest(w http.ResponseWriter, r *http.Request) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	var p struct{ Decision string }
	if !readJSON(w, r, &p) {
		return
	}
	if p.Decision != "approve" && p.Decision != "decline" {
		problem(w, r, 400, "invalid_decision", "Choose approve or decline.")
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var requester string
	err = tx.QueryRow(ctx, "SELECT requester_id FROM contact_requests WHERE id=$1 AND issuer_id=$2", id, user.ID).Scan(&requester)
	if !chatResult(w, r, err) {
		return
	}
	// Lock the two accounts in UUID order so opposite-direction approvals serialize.
	locked, err := tx.Exec(ctx, "SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR NO KEY UPDATE", user.ID, requester)
	if err != nil {
		failure(w, r)
		return
	}
	if locked.RowsAffected() != 2 {
		missing(w, r)
		return
	}

	var status string
	err = tx.QueryRow(ctx, "SELECT status FROM contact_requests WHERE id=$1 FOR UPDATE", id).Scan(&status)
	if !chatResult(w, r, err) {
		return
	}
	if p.Decision == "decline" {
		if status == "approved" {
			problem(w, r, 409, "already_decided", "This contact request is already approved.")
			return
		}
		if _, err := tx.Exec(ctx, "UPDATE contact_requests SET status='declined' WHERE id=$1", id); err != nil {
			failure(w, r)
			return
		}
		if err := tx.Commit(ctx); err != nil {
			failure(w, r)
			return
		}
		w.WriteHeader(204)
		return
	}
	if status == "declined" {
		problem(w, r, 409, "already_decided", "This contact request is already declined.")
		return
	}
	var direct string
	err = tx.QueryRow(ctx, `SELECT conversation_id FROM direct_pairs
        WHERE first_user=LEAST($1::uuid,$2::uuid) AND second_user=GREATEST($1::uuid,$2::uuid)`, user.ID, requester).Scan(&direct)
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(ctx, `WITH created AS (
            INSERT INTO conversations (title,owner_id,kind) VALUES ('Direct chat',$1,'direct') RETURNING id
        ), joined AS (
            INSERT INTO memberships (conversation_id,user_id,role)
            SELECT id,$1::uuid,'member' FROM created UNION ALL SELECT id,$2::uuid,'member' FROM created
        ) INSERT INTO direct_pairs(first_user,second_user,conversation_id)
          SELECT LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid),id FROM created RETURNING conversation_id`,
			user.ID, requester).Scan(&direct)
	}
	if err != nil {
		failure(w, r)
		return
	}
	if _, err := tx.Exec(ctx, "UPDATE contact_requests SET status='approved' WHERE id=$1", id); err != nil {
		failure(w, r)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		failure(w, r)
		return
	}
	respond(w, 200, map[string]string{"conversationId": direct})
}
