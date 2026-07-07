package models

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ClassificationJob struct {
	BookID    uuid.UUID
	Status    string
	Attempts  int
	LastError string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type ClassificationJobRepository struct {
	pool *pgxpool.Pool
}

func NewClassificationJobRepository(pool *pgxpool.Pool) *ClassificationJobRepository {
	return &ClassificationJobRepository{pool: pool}
}

func (r *ClassificationJobRepository) Upsert(
	ctx context.Context,
	bookID uuid.UUID,
	status string,
	lastError string,
) (*ClassificationJob, error) {
	var job ClassificationJob
	err := r.pool.QueryRow(ctx, `
		INSERT INTO classification_jobs (book_id, status, attempts, last_error)
		VALUES ($1, $2, CASE WHEN $2 = 'running' THEN 1 ELSE 0 END, $3)
		ON CONFLICT (book_id)
		DO UPDATE SET status = EXCLUDED.status,
			attempts = CASE
				WHEN EXCLUDED.status = 'running' THEN classification_jobs.attempts + 1
				ELSE classification_jobs.attempts
			END,
			last_error = EXCLUDED.last_error,
			updated_at = NOW()
		RETURNING book_id, status, attempts, last_error, created_at, updated_at
	`, bookID, status, lastError).Scan(
		&job.BookID,
		&job.Status,
		&job.Attempts,
		&job.LastError,
		&job.CreatedAt,
		&job.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *ClassificationJobRepository) ListByStatus(
	ctx context.Context,
	statuses []string,
	limit int,
) ([]ClassificationJob, error) {
	if limit <= 0 {
		limit = 50
	}

	rows, err := r.pool.Query(ctx, `
		SELECT book_id, status, attempts, last_error, created_at, updated_at
		FROM classification_jobs
		WHERE status = ANY($1)
		ORDER BY updated_at ASC
		LIMIT $2
	`, statuses, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var jobs []ClassificationJob
	for rows.Next() {
		var job ClassificationJob
		if err := rows.Scan(
			&job.BookID,
			&job.Status,
			&job.Attempts,
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

func (r *ClassificationJobRepository) Get(ctx context.Context, bookID uuid.UUID) (*ClassificationJob, error) {
	var job ClassificationJob
	err := r.pool.QueryRow(ctx, `
		SELECT book_id, status, attempts, last_error, created_at, updated_at
		FROM classification_jobs
		WHERE book_id = $1
	`, bookID).Scan(
		&job.BookID,
		&job.Status,
		&job.Attempts,
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
