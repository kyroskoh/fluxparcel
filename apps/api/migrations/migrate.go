// Package migrations applies the ordered, embedded FluxParcel schema.
package migrations

import (
	"context"
	"embed"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

func Apply(ctx context.Context, db *pgxpool.Pool) error {
	entries, err := fs.Glob(files, "*.sql")
	if err != nil {
		return err
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(781408894588617442)"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	for _, name := range entries {
		var applied bool
		if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name=$1)", name).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		sql, err := files.ReadFile(name)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations (name) VALUES ($1)", name); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
