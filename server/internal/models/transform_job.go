package models

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type TransformJob struct {
	ID        uuid.UUID
	BookID    uuid.UUID
	DestKey   string
	Status    string
	LastError string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type TransformJobRepository struct {
	pool *pgxpool.Pool
}

func NewTransformJobRepository(pool *pgxpool.Pool) *TransformJobRepository {
	return &TransformJobRepository{pool: pool}
}

func (r *TransformJobRepository) Upsert(
	ctx context.Context,
	bookID uuid.UUID,
	destKey string,
	status string,
	lastError string,
) (*TransformJob, error) {
	var job TransformJob
	err := r.pool.QueryRow(ctx, `
		INSERT INTO transform_jobs (book_id, dest_key, status, last_error)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (book_id)
		DO UPDATE SET dest_key = EXCLUDED.dest_key,
			status = EXCLUDED.status,
			last_error = EXCLUDED.last_error,
			updated_at = NOW()
		RETURNING id, book_id, dest_key, status, last_error, created_at, updated_at
	`, bookID, destKey, status, lastError).Scan(
		&job.ID,
		&job.BookID,
		&job.DestKey,
		&job.Status,
		&job.LastError,
		&job.CreatedAt,
		&job.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *TransformJobRepository) GetByBookID(ctx context.Context, bookID uuid.UUID) (*TransformJob, error) {
	var job TransformJob
	err := r.pool.QueryRow(ctx, `
		SELECT id, book_id, dest_key, status, last_error, created_at, updated_at
		FROM transform_jobs
		WHERE book_id = $1
	`, bookID).Scan(
		&job.ID,
		&job.BookID,
		&job.DestKey,
		&job.Status,
		&job.LastError,
		&job.CreatedAt,
		&job.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &job, nil
}

func (r *TransformJobRepository) ListByStatus(
	ctx context.Context,
	statuses []string,
	limit int,
) ([]TransformJob, error) {
	if limit <= 0 {
		limit = 50
	}

	rows, err := r.pool.Query(ctx, `
		SELECT id, book_id, dest_key, status, last_error, created_at, updated_at
		FROM transform_jobs
		WHERE status = ANY($1)
		ORDER BY updated_at ASC
		LIMIT $2
	`, statuses, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []TransformJob
	for rows.Next() {
		var job TransformJob
		if err := rows.Scan(
			&job.ID,
			&job.BookID,
			&job.DestKey,
			&job.Status,
			&job.LastError,
			&job.CreatedAt,
			&job.UpdatedAt,
		); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}
