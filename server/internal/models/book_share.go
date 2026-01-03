package models

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BookShare struct {
	ID        uuid.UUID `json:"id"`
	BookID    uuid.UUID `json:"book_id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type BookShareRepository struct {
	pool *pgxpool.Pool
}

func NewBookShareRepository(pool *pgxpool.Pool) *BookShareRepository {
	return &BookShareRepository{pool: pool}
}

func (r *BookShareRepository) Add(ctx context.Context, bookID uuid.UUID, email string) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO book_shares (book_id, email)
		VALUES ($1, $2)
		ON CONFLICT (book_id, email) DO UPDATE
		SET updated_at = NOW()
	`, bookID, email)
	return err
}

func (r *BookShareRepository) Remove(ctx context.Context, bookID uuid.UUID, email string) error {
	_, err := r.pool.Exec(ctx, `
		DELETE FROM book_shares
		WHERE book_id = $1 AND email = $2
	`, bookID, email)
	return err
}

func (r *BookShareRepository) ListByBookID(ctx context.Context, bookID uuid.UUID) ([]BookShare, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, book_id, email, created_at, updated_at
		FROM book_shares
		WHERE book_id = $1
		ORDER BY created_at ASC
	`, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var shares []BookShare
	for rows.Next() {
		var share BookShare
		if err := rows.Scan(
			&share.ID,
			&share.BookID,
			&share.Email,
			&share.CreatedAt,
			&share.UpdatedAt,
		); err != nil {
			return nil, err
		}
		shares = append(shares, share)
	}
	return shares, rows.Err()
}

func (r *BookShareRepository) HasAccess(ctx context.Context, bookID uuid.UUID, email string) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM book_shares WHERE book_id = $1 AND email = $2
		)
	`, bookID, email).Scan(&exists)
	return exists, err
}
