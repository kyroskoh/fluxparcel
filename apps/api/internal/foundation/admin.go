package foundation

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
)

func (s *Server) adminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/admin/storage", s.storageSummary)
	mux.HandleFunc("GET /v1/admin/snapshots", s.listSnapshots)
	mux.HandleFunc("POST /v1/admin/snapshots/{id}/restore", s.limit("admin-change", 60, s.restoreSnapshot))
	mux.HandleFunc("DELETE /v1/admin/snapshots/{id}", s.limit("admin-change", 60, s.purgeSnapshot))
}

// requireAdmin answers not found to everyone else, so the administration surface is not revealed.
func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) (account, bool) {
	user, _, ok := s.authenticate(w, r)
	if !ok {
		return user, false
	}
	if !user.Admin {
		missing(w, r)
		return user, false
	}
	return user, true
}

type usage struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}

func (s *Server) storageSummary(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	ctx := r.Context()
	files := map[string]usage{"active": {}, "snapshot": {}, "purged": {}}
	rows, err := s.DB.Query(ctx, `SELECT lifecycle,count(*),COALESCE(sum(size),0)::bigint FROM files GROUP BY lifecycle`)
	if err != nil {
		failure(w, r)
		return
	}
	for rows.Next() {
		var lifecycle string
		var item usage
		if err := rows.Scan(&lifecycle, &item.Count, &item.Bytes); err != nil {
			rows.Close()
			failure(w, r)
			return
		}
		files[lifecycle] = item
	}
	rows.Close()
	var uploads usage
	err = s.DB.QueryRow(ctx, `SELECT count(DISTINCT t.id),COALESCE(sum(p.size),0)::bigint FROM transfers t
        LEFT JOIN transfer_parts p ON p.transfer_id=t.id WHERE t.state IN ('uploading','verifying')`).Scan(&uploads.Count, &uploads.Bytes)
	if rows.Err() != nil || err != nil {
		failure(w, r)
		return
	}
	respond(w, 200, map[string]any{
		"files": files, "uploads": uploads,
		"retention": map[string]int64{
			"fileSeconds": int64(s.fileRetention().Seconds()), "snapshotSeconds": int64(s.SnapshotRetention.Seconds()),
		},
	})
}

type snapshot struct {
	ID                string    `json:"id"`
	Name              string    `json:"name"`
	Size              int64     `json:"size"`
	SHA256            string    `json:"sha256"`
	Conversation      string    `json:"conversation"`
	Owner             string    `json:"owner"`
	ExpiredAt         time.Time `json:"expiredAt"`
	SnapshotExpiresAt time.Time `json:"snapshotExpiresAt"`
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdmin(w, r); !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT f.id::text,f.name,f.size,encode(f.sha256,'hex'),c.title,
            COALESCE(u.display_name,'Deleted account'),f.expired_at,f.snapshot_expires_at
        FROM files f JOIN conversations c ON c.id=f.conversation_id LEFT JOIN users u ON u.id=f.owner_id
        WHERE f.lifecycle='snapshot' ORDER BY f.expired_at DESC,f.id LIMIT 200`)
	if err != nil {
		failure(w, r)
		return
	}
	result, err := pgx.CollectRows(rows, pgx.RowToStructByPos[snapshot])
	if err != nil {
		failure(w, r)
		return
	}
	if result == nil {
		result = []snapshot{}
	}
	respond(w, 200, result)
}

// restoreSnapshot makes an expired file available to the conversation's members again with a new expiry.
func (s *Server) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	var input struct{ ExpiresInSeconds int64 }
	if !readJSON(w, r, &input) {
		return
	}
	if input.ExpiresInSeconds == 0 {
		input.ExpiresInSeconds = int64((7 * 24 * time.Hour).Seconds())
	}
	if input.ExpiresInSeconds < int64(minFileLifetime.Seconds()) || input.ExpiresInSeconds > int64(s.fileRetention().Seconds()) {
		problem(w, r, 400, "invalid_expiry", "Choose an expiry between 1 minute and "+s.fileRetention().String()+".")
		return
	}
	user, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var conversationID string
	var expires time.Time
	err = tx.QueryRow(ctx, `UPDATE files f SET lifecycle='active',expires_at=now()+make_interval(secs => $2),expired_at=NULL,
            snapshot_expires_at=NULL,restored_at=now()
        WHERE f.id=$1 AND f.lifecycle='snapshot'
          AND EXISTS (SELECT 1 FROM messages m WHERE m.file_id=f.id AND m.deleted_at IS NULL)
        RETURNING f.conversation_id,f.expires_at`, id, input.ExpiresInSeconds).Scan(&conversationID, &expires)
	if err == nil {
		err = touchFileMessages(ctx, tx, conversationID, id)
	}
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO admin_audit(actor_id,action,file_id) VALUES ($1,'snapshot.restore',$2)`, user.ID, id)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if !chatResult(w, r, err) {
		return
	}
	s.notifyMessage(ctx, conversationID)
	respond(w, 200, map[string]any{"id": id, "expiresAt": expires})
}

// purgeSnapshot deletes a snapshot's bytes before its retention ends. The row is claimed first, so a concurrent
// restore cannot make a file available after its bytes are gone.
func (s *Server) purgeSnapshot(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireAdmin(w, r)
	if !ok {
		return
	}
	id := r.PathValue("id")
	if !uuidPattern.MatchString(id) {
		missing(w, r)
		return
	}
	ctx := r.Context()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		failure(w, r)
		return
	}
	defer tx.Rollback(ctx)
	var key string
	err = tx.QueryRow(ctx, `UPDATE files SET lifecycle='purged' WHERE id=$1 AND lifecycle='snapshot' RETURNING object_key`, id).Scan(&key)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO admin_audit(actor_id,action,file_id) VALUES ($1,'snapshot.purge',$2)`, user.ID, id)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if !chatResult(w, r, err) {
		return
	}
	// If removal fails, storage reconciliation deletes the unreferenced object later.
	if s.Objects.RemoveObject(context.WithoutCancel(ctx), s.Bucket, key, minio.RemoveObjectOptions{}) == nil {
		_, _ = s.DB.Exec(context.WithoutCancel(ctx), `UPDATE files SET removed_at=now() WHERE id=$1`, id)
	}
	w.WriteHeader(204)
}

// touchFileMessages gives the messages that carry a file a new version, so every open chat and device picks up
// a change in the file's availability through the change cursor.
func touchFileMessages(ctx context.Context, tx pgx.Tx, conversationID, fileID string) error {
	var version int64
	err := tx.QueryRow(ctx, `UPDATE conversations SET message_version=message_version+1 WHERE id=$1 RETURNING message_version`,
		conversationID).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE messages SET version=$2 WHERE conversation_id=$1 AND file_id=$3`, conversationID, version, fileID)
	}
	return err
}
