package foundation

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
)

// completedTransferRetention keeps finished transfer records long enough to answer retried completions.
const completedTransferRetention = "7 days"

// Janitor removes stored bytes that no longer have a purpose. Each pass handles bounded batches, so a large
// backlog drains over several passes instead of holding long transactions.
type Janitor struct {
	DB      *pgxpool.Pool
	Objects *minio.Client
	Bucket  string
	// OrphanAge protects objects and uploads that are still being written or published.
	OrphanAge time.Duration
	// SnapshotRetention keeps expired files for administrator restoration; zero purges them at expiry.
	SnapshotRetention time.Duration
	// Notify, when set, tells open chats in a conversation to synchronize.
	Notify func(ctx context.Context, conversationID string)
}

// CleanupReport counts what one pass removed.
type CleanupReport struct {
	Transfers, Expired, Purged, Orphans, Uploads int
}

// Sweep advances the storage lifecycle: it closes finished or abandoned transfers, expires files past their
// expiry, and purges snapshots past their retention and files whose message was deleted.
func (j *Janitor) Sweep(ctx context.Context) (CleanupReport, error) {
	var report CleanupReport
	var err error
	if report.Transfers, err = j.closeTransfers(ctx); err != nil {
		return report, err
	}
	if report.Expired, err = j.expireFiles(ctx); err != nil {
		return report, err
	}
	report.Purged, err = j.purgeFiles(ctx)
	return report, err
}

// closeTransfers aborts the multipart uploads of cancelled, failed and expired transfers, removes any partial
// object, and deletes the transfer record. Completed transfers only lose their record; the file keeps its bytes.
func (j *Janitor) closeTransfers(ctx context.Context) (int, error) {
	rows, err := j.DB.Query(ctx, `SELECT id,state,object_key,upload_id FROM transfers
        WHERE state IN ('cancelled','failed')
           OR (state IN ('uploading','verifying') AND expires_at<=now())
           OR (state='completed' AND updated_at<now()-interval '`+completedTransferRetention+`')
        ORDER BY updated_at LIMIT 100`)
	if err != nil {
		return 0, err
	}
	type pending struct{ id, state, key, upload string }
	var batch []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.state, &item.key, &item.upload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	closed := 0
	core := minio.Core{Client: j.Objects}
	for _, item := range batch {
		if item.state != "completed" {
			if err := core.AbortMultipartUpload(ctx, j.Bucket, item.key, item.upload); err != nil && !missingUpload(err) {
				continue
			}
			if err := j.Objects.RemoveObject(ctx, j.Bucket, item.key, minio.RemoveObjectOptions{}); err != nil {
				continue
			}
		}
		// Compare the state so a transfer that changed since it was read is reconsidered next pass.
		tag, err := j.DB.Exec(ctx, `DELETE FROM transfers WHERE id=$1 AND state=$2`, item.id, item.state)
		if err != nil {
			return closed, err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		closed++
		if _, err := j.DB.Exec(ctx, `DELETE FROM multipart_uploads WHERE upload_id=$1`, item.upload); err != nil {
			return closed, err
		}
	}
	return closed, nil
}

// expireFiles ends the availability of files past their expiry for every member. With snapshot retention, the
// bytes stay as an administrator-only snapshot; otherwise the snapshot expires at once and the same pass purges it.
// Touching the file's messages lets open chats and other devices learn about the expiry through synchronization.
func (j *Janitor) expireFiles(ctx context.Context) (int, error) {
	rows, err := j.DB.Query(ctx, `SELECT id,conversation_id FROM files
        WHERE lifecycle='active' AND expires_at<=now() ORDER BY expires_at LIMIT 100`)
	if err != nil {
		return 0, err
	}
	type pending struct{ id, conversation string }
	var batch []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.conversation); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	expired := 0
	for _, item := range batch {
		changed, err := j.expireFile(ctx, item.id, item.conversation)
		if err != nil {
			return expired, err
		}
		if changed {
			expired++
			if j.Notify != nil {
				j.Notify(ctx, item.conversation)
			}
		}
	}
	return expired, nil
}

func (j *Janitor) expireFile(ctx context.Context, fileID, conversationID string) (bool, error) {
	tx, err := j.DB.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE files SET lifecycle='snapshot',expired_at=now(),
            snapshot_expires_at=now()+make_interval(secs => $2)
        WHERE id=$1 AND lifecycle='active' AND expires_at<=now()`, fileID, j.SnapshotRetention.Seconds())
	if err != nil || tag.RowsAffected() == 0 {
		return false, err
	}
	if err := touchFileMessages(ctx, tx, conversationID, fileID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// purgeFiles deletes the bytes of snapshots past their retention and of files whose message was deleted. Each row is
// claimed before its bytes are removed, so a concurrent restore cannot revive a file whose bytes are gone.
func (j *Janitor) purgeFiles(ctx context.Context) (int, error) {
	rows, err := j.DB.Query(ctx, `UPDATE files f SET lifecycle='purged' WHERE f.id IN (
            SELECT id FROM files WHERE (lifecycle='snapshot' AND snapshot_expires_at<=now())
               OR (lifecycle IN ('active','snapshot')
                   AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id=files.id AND m.deleted_at IS NULL))
            ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)
        RETURNING f.id,f.object_key`)
	if err != nil {
		return 0, err
	}
	type pending struct{ id, key string }
	var batch []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.key); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, item := range batch {
		// A failed removal leaves an unreferenced object that reconciliation deletes later.
		if err := j.Objects.RemoveObject(ctx, j.Bucket, item.key, minio.RemoveObjectOptions{}); err != nil {
			continue
		}
		if _, err := j.DB.Exec(ctx, `UPDATE files SET removed_at=now() WHERE id=$1`, item.id); err != nil {
			return len(batch), err
		}
	}
	return len(batch), nil
}

// Reconcile removes stored objects and incomplete uploads that no record refers to, such as those left behind
// when a conversation or account is deleted. It is slower than Sweep and runs less often.
func (j *Janitor) Reconcile(ctx context.Context) (CleanupReport, error) {
	// Cancelling stops the listing goroutines when a scan ends early.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var report CleanupReport
	cutoff := time.Now().Add(-j.OrphanAge)
	scanned := 0
	for object := range j.Objects.ListObjects(ctx, j.Bucket, minio.ListObjectsOptions{Prefix: "files/", Recursive: true}) {
		if object.Err != nil {
			return report, object.Err
		}
		if scanned++; scanned > 10000 {
			break
		}
		if object.LastModified.After(cutoff) {
			continue
		}
		var referenced bool
		if err := j.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE object_key=$1 AND lifecycle IN ('active','snapshot'))
            OR EXISTS (SELECT 1 FROM transfers WHERE object_key=$1)`, object.Key).Scan(&referenced); err != nil {
			return report, err
		}
		if !referenced && j.Objects.RemoveObject(ctx, j.Bucket, object.Key, minio.RemoveObjectOptions{}) == nil {
			report.Orphans++
		}
	}
	// Not every S3-compatible store lists incomplete uploads, so use the API's own ledger instead.
	rows, err := j.DB.Query(ctx, `SELECT u.upload_id,u.object_key FROM multipart_uploads u
        WHERE u.created_at<=$1 AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.upload_id=u.upload_id)
        ORDER BY u.created_at LIMIT 1000`, cutoff)
	if err != nil {
		return report, err
	}
	type pending struct{ upload, key string }
	var batch []pending
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.upload, &item.key); err != nil {
			rows.Close()
			return report, err
		}
		batch = append(batch, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return report, err
	}
	core := minio.Core{Client: j.Objects}
	for _, item := range batch {
		if err := core.AbortMultipartUpload(ctx, j.Bucket, item.key, item.upload); err != nil && !missingUpload(err) {
			continue
		}
		if _, err := j.DB.Exec(ctx, `DELETE FROM multipart_uploads WHERE upload_id=$1`, item.upload); err != nil {
			return report, err
		}
		report.Uploads++
	}
	return report, nil
}

func missingUpload(err error) bool {
	return minio.ToErrorResponse(err).Code == "NoSuchUpload"
}
