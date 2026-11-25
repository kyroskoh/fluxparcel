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
}

// CleanupReport counts what one pass removed.
type CleanupReport struct {
	Transfers, Files, Orphans, Uploads int
}

// Sweep closes finished or abandoned transfers and removes expired or deleted files.
func (j *Janitor) Sweep(ctx context.Context) (CleanupReport, error) {
	var report CleanupReport
	transfers, err := j.closeTransfers(ctx)
	report.Transfers = transfers
	if err != nil {
		return report, err
	}
	report.Files, err = j.removeFiles(ctx)
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

// removeFiles deletes the bytes of expired files and of files whose message was deleted, then marks them removed.
func (j *Janitor) removeFiles(ctx context.Context) (int, error) {
	rows, err := j.DB.Query(ctx, `SELECT f.id,f.object_key FROM files f WHERE f.removed_at IS NULL AND (f.expires_at<=now()
        OR NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id=f.id AND m.deleted_at IS NULL))
        ORDER BY f.expires_at LIMIT 100`)
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
	removed := 0
	for _, item := range batch {
		if err := j.Objects.RemoveObject(ctx, j.Bucket, item.key, minio.RemoveObjectOptions{}); err != nil {
			continue
		}
		tag, err := j.DB.Exec(ctx, `UPDATE files SET removed_at=now() WHERE id=$1 AND removed_at IS NULL`, item.id)
		if err != nil {
			return removed, err
		}
		removed += int(tag.RowsAffected())
	}
	return removed, nil
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
		if err := j.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM files WHERE object_key=$1 AND removed_at IS NULL)
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
