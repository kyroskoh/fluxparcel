package foundation

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// TestJanitorAgainstStorage runs against real PostgreSQL and S3-compatible storage when
// FLUXPARCEL_TEST_DATABASE_URL and FLUXPARCEL_TEST_S3_* are set, as in CI; otherwise it is skipped.
func TestJanitorAgainstStorage(t *testing.T) {
	databaseURL := os.Getenv("FLUXPARCEL_TEST_DATABASE_URL")
	endpoint := os.Getenv("FLUXPARCEL_TEST_S3_ENDPOINT")
	if databaseURL == "" || endpoint == "" {
		t.Skip("set FLUXPARCEL_TEST_DATABASE_URL and FLUXPARCEL_TEST_S3_* to run against real storage")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	objects, err := minio.New(endpoint, &minio.Options{
		Creds: credentials.NewStaticV4(os.Getenv("FLUXPARCEL_TEST_S3_ACCESS_KEY"), os.Getenv("FLUXPARCEL_TEST_S3_SECRET_KEY"), ""),
	})
	if err != nil {
		t.Fatal(err)
	}
	bucket := os.Getenv("FLUXPARCEL_TEST_S3_BUCKET")
	core := minio.Core{Client: objects}
	suffix := strings.ToLower(rand.Text()[:12])

	var userID, conversationID string
	must(t, db.QueryRow(ctx, `INSERT INTO users(email,username,display_name,password_hash) VALUES ($1,$2,'Janitor test','x')
        RETURNING id`, "janitor_"+suffix+"@example.test", "janitor_"+suffix).Scan(&userID))
	defer db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	must(t, db.QueryRow(ctx, `INSERT INTO conversations(title,owner_id) VALUES ('Janitor',$1) RETURNING id`, userID).Scan(&conversationID))
	_, err = db.Exec(ctx, `INSERT INTO memberships(conversation_id,user_id,role) VALUES ($1,$2,'owner')`, conversationID, userID)
	must(t, err)

	data := []byte("janitor test bytes")
	sum := sha256.Sum256(data)
	key := func(name string) string { return "files/janitor-" + suffix + "-" + name }
	putObject := func(name string) {
		_, err := objects.PutObject(ctx, bucket, key(name), bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{})
		must(t, err)
	}
	// Uploads are recorded in the ledger as the API does; the oldest entries count as abandoned.
	startUpload := func(name string) string {
		upload, err := core.NewMultipartUpload(ctx, bucket, key(name), minio.PutObjectOptions{})
		must(t, err)
		_, err = db.Exec(ctx, `INSERT INTO multipart_uploads(upload_id,object_key,created_at) VALUES ($1,$2,now()-interval '2 days')`, upload, key(name))
		must(t, err)
		_, err = core.PutObjectPart(ctx, bucket, key(name), upload, 1, bytes.NewReader(data), int64(len(data)), minio.PutObjectPartOptions{})
		must(t, err)
		return upload
	}
	transfer := func(name, state, upload, expires, updated string) {
		_, err := db.Exec(ctx, `INSERT INTO transfers(sender_id,conversation_id,client_id,name,mime,size,sha256,part_size,object_key,
                upload_id,state,expires_at,updated_at)
            VALUES ($1,$2,gen_random_uuid(),$3,'application/octet-stream',$4,$5,8388608,$6,$7,$8,now()+$9::interval,now()+$10::interval)`,
			userID, conversationID, name, len(data), sum[:], key(name), upload, state, expires, updated)
		must(t, err)
	}
	var sequence int64
	file := func(name, expires string, deleted bool) string {
		putObject(name)
		var id string
		must(t, db.QueryRow(ctx, `INSERT INTO files(conversation_id,owner_id,object_key,name,mime,size,sha256,expires_at)
            VALUES ($1,$2,$3,$4,'application/octet-stream',$5,$6,now()+$7::interval) RETURNING id`,
			conversationID, userID, key(name), name, len(data), sum[:], expires).Scan(&id))
		sequence++
		deletedAt := any(nil)
		if deleted {
			deletedAt = time.Now()
		}
		_, err := db.Exec(ctx, `INSERT INTO messages(conversation_id,sequence,version,sender_id,client_id,body,body_digest,file_id,deleted_at)
            VALUES ($1,$2,$2,$3,gen_random_uuid(),'',$4,$5,$6)`, conversationID, sequence, userID, digest(""), id, deletedAt)
		must(t, err)
		return id
	}

	cancelledUpload := startUpload("cancelled")
	transfer("cancelled", "cancelled", cancelledUpload, "1 day", "0 seconds")
	expiredUpload := startUpload("expired")
	transfer("expired", "uploading", expiredUpload, "-1 minute", "0 seconds")
	activeUpload := startUpload("active")
	transfer("active", "uploading", activeUpload, "1 day", "0 seconds")
	kept := file("kept", "30 days", false)
	transfer("completed", "completed", "finished", "1 day", "-8 days")
	deletedMessage := file("deleted", "30 days", true)
	expired := file("old", "-1 minute", false)
	putObject("orphan")
	// An upload whose transfer was deleted with its account or conversation.
	orphanUpload := startUpload("orphan-upload")

	// Age zero is safe here: live objects and uploads are always referenced by a file or transfer record.
	janitor := &Janitor{DB: db, Objects: objects, Bucket: bucket}
	// The worker may sweep concurrently, so assert outcomes rather than what this pass reports.
	_, err = janitor.Sweep(ctx)
	must(t, err)
	_, err = janitor.Reconcile(ctx)
	must(t, err)

	exists := func(name string) bool {
		_, err := objects.StatObject(ctx, bucket, key(name), minio.StatObjectOptions{})
		return err == nil
	}
	uploadOpen := func(name, upload string) bool {
		_, err := core.ListObjectParts(ctx, bucket, key(name), upload, 0, 10)
		return err == nil
	}
	if !exists("kept") || exists("deleted") || exists("old") || exists("orphan") {
		t.Fatal("cleanup kept the wrong objects")
	}
	if uploadOpen("cancelled", cancelledUpload) || uploadOpen("expired", expiredUpload) || uploadOpen("orphan-upload", orphanUpload) {
		t.Fatal("cleanup left an abandoned multipart upload open")
	}
	if !uploadOpen("active", activeUpload) {
		t.Fatal("cleanup aborted an active upload")
	}
	var transfers int
	must(t, db.QueryRow(ctx, `SELECT count(*) FROM transfers WHERE sender_id=$1`, userID).Scan(&transfers))
	if transfers != 1 {
		t.Fatalf("expected only the active transfer to remain, found %d", transfers)
	}
	var removed []bool
	for _, id := range []string{kept, deletedMessage, expired} {
		var isRemoved bool
		must(t, db.QueryRow(ctx, `SELECT removed_at IS NOT NULL FROM files WHERE id=$1`, id).Scan(&isRemoved))
		removed = append(removed, isRemoved)
	}
	if removed[0] || !removed[1] || !removed[2] {
		t.Fatalf("unexpected removal flags: %v", removed)
	}
	var ledger int
	must(t, db.QueryRow(ctx, `SELECT count(*) FROM multipart_uploads WHERE upload_id = ANY($1)`,
		[]string{cancelledUpload, expiredUpload, orphanUpload, activeUpload}).Scan(&ledger))
	if ledger != 1 {
		t.Fatalf("expected only the active upload in the ledger, found %d", ledger)
	}
	_, _ = db.Exec(context.Background(), `DELETE FROM multipart_uploads WHERE upload_id=$1`, activeUpload)
	_ = core.AbortMultipartUpload(context.Background(), bucket, key("active"), activeUpload)
	_ = objects.RemoveObject(context.Background(), bucket, key("kept"), minio.RemoveObjectOptions{})
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
