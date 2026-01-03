package models

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Book struct {
	ID                 uuid.UUID           `json:"id"`
	URL                string              `json:"url"`
	Title              string              `json:"title"`
	Authors            []string            `json:"authors"`
	ThumbnailURL       string              `json:"thumbnail_url"`
	TransformationData map[string][]string `json:"transformation_data"`
	Visibility         string              `json:"visibility"`
	OwnerUserID        *uuid.UUID          `json:"owner_user_id"`
	CreatedAt          time.Time           `json:"created_at"`
	UpdatedAt          time.Time           `json:"updated_at"`
}

type BookRepository struct {
	pool *pgxpool.Pool
}

func NewBookRepository(pool *pgxpool.Pool) *BookRepository {
	return &BookRepository{pool: pool}
}

func (r *BookRepository) GetAll(ctx context.Context) ([]Book, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, url, title, authors, thumbnail_url, transformation_data, visibility, owner_user_id, created_at, updated_at
		FROM books
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []Book
	for rows.Next() {
		var book Book
		var transformationDataJSON []byte

		err := rows.Scan(
			&book.ID,
			&book.URL,
			&book.Title,
			&book.Authors,
			&book.ThumbnailURL,
			&transformationDataJSON,
			&book.Visibility,
			&book.OwnerUserID,
			&book.CreatedAt,
			&book.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
			book.TransformationData = make(map[string][]string)
		}

		books = append(books, book)
	}

	return books, rows.Err()
}

func (r *BookRepository) GetAllPublic(ctx context.Context) ([]Book, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, url, title, authors, thumbnail_url, transformation_data, visibility, owner_user_id, created_at, updated_at
		FROM books
		WHERE visibility = 'public'
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []Book
	for rows.Next() {
		var book Book
		var transformationDataJSON []byte

		err := rows.Scan(
			&book.ID,
			&book.URL,
			&book.Title,
			&book.Authors,
			&book.ThumbnailURL,
			&transformationDataJSON,
			&book.Visibility,
			&book.OwnerUserID,
			&book.CreatedAt,
			&book.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
			book.TransformationData = make(map[string][]string)
		}

		books = append(books, book)
	}

	return books, rows.Err()
}

func (r *BookRepository) GetAllForUser(ctx context.Context, userID uuid.UUID, email string) ([]Book, error) {
	normalized := NormalizeEmail(email)
	rows, err := r.pool.Query(ctx, `
		SELECT DISTINCT b.id, b.url, b.title, b.authors, b.thumbnail_url, b.transformation_data,
		       b.visibility, b.owner_user_id, b.created_at, b.updated_at
		FROM books b
		LEFT JOIN book_shares bs ON bs.book_id = b.id AND bs.email = $2
		WHERE b.visibility = 'public'
		   OR b.owner_user_id = $1
		   OR bs.email IS NOT NULL
		ORDER BY b.created_at DESC
	`, userID, normalized)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []Book
	for rows.Next() {
		var book Book
		var transformationDataJSON []byte

		err := rows.Scan(
			&book.ID,
			&book.URL,
			&book.Title,
			&book.Authors,
			&book.ThumbnailURL,
			&transformationDataJSON,
			&book.Visibility,
			&book.OwnerUserID,
			&book.CreatedAt,
			&book.UpdatedAt,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
			book.TransformationData = make(map[string][]string)
		}

		books = append(books, book)
	}

	return books, rows.Err()
}

func (r *BookRepository) HasAccess(ctx context.Context, bookID uuid.UUID, userID *uuid.UUID, email string) (bool, error) {
	var visibility string
	var ownerID *uuid.UUID
	err := r.pool.QueryRow(ctx, `
		SELECT visibility, owner_user_id
		FROM books
		WHERE id = $1
	`, bookID).Scan(&visibility, &ownerID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}

	if visibility == "" {
		visibility = "public"
	}
	if visibility == "public" {
		return true, nil
	}

	if userID != nil && ownerID != nil && *userID == *ownerID {
		return true, nil
	}

	normalized := NormalizeEmail(email)
	if normalized == "" {
		return false, nil
	}

	var exists bool
	err = r.pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM book_shares WHERE book_id = $1 AND email = $2
		)
	`, bookID, normalized).Scan(&exists)
	return exists, err
}

func (r *BookRepository) GetByID(ctx context.Context, id uuid.UUID) (*Book, error) {
	var book Book
	var transformationDataJSON []byte

	err := r.pool.QueryRow(ctx, `
		SELECT id, url, title, authors, thumbnail_url, transformation_data, visibility, owner_user_id, created_at, updated_at
		FROM books
		WHERE id = $1
	`, id).Scan(
		&book.ID,
		&book.URL,
		&book.Title,
		&book.Authors,
		&book.ThumbnailURL,
		&transformationDataJSON,
		&book.Visibility,
		&book.OwnerUserID,
		&book.CreatedAt,
		&book.UpdatedAt,
	)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}

	if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
		book.TransformationData = make(map[string][]string)
	}

	return &book, nil
}

func (r *BookRepository) Create(ctx context.Context, book *Book) error {
	if book.ID == uuid.Nil {
		book.ID = uuid.New()
	}
	if book.TransformationData == nil {
		book.TransformationData = make(map[string][]string)
	}
	if book.Visibility == "" {
		book.Visibility = "public"
	}
	if book.Authors == nil {
		book.Authors = []string{}
	}

	transformationDataJSON, err := json.Marshal(book.TransformationData)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO books (id, url, title, authors, thumbnail_url, transformation_data, visibility, owner_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
	`, book.ID, book.URL, book.Title, book.Authors, book.ThumbnailURL, transformationDataJSON, book.Visibility, book.OwnerUserID)

	return err
}

func (r *BookRepository) SetTransformURLs(
	ctx context.Context,
	id uuid.UUID,
	key string,
	urls []string,
) error {
	var current map[string][]string
	var transformationDataJSON []byte
	err := r.pool.QueryRow(ctx, `
		SELECT transformation_data
		FROM books
		WHERE id = $1
	`, id).Scan(&transformationDataJSON)
	if err != nil {
		if err == pgx.ErrNoRows {
			return err
		}
		return err
	}
	if err := json.Unmarshal(transformationDataJSON, &current); err != nil {
		current = make(map[string][]string)
	}
	current[key] = urls

	payload, err := json.Marshal(current)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		UPDATE books
		SET transformation_data = $2, updated_at = NOW()
		WHERE id = $1
	`, id, payload)
	return err
}

func (r *BookRepository) Upsert(ctx context.Context, book *Book) error {
	if book.ID == uuid.Nil {
		book.ID = uuid.New()
	}
	if book.TransformationData == nil {
		book.TransformationData = make(map[string][]string)
	}
	if book.Visibility == "" {
		book.Visibility = "public"
	}
	if book.Authors == nil {
		book.Authors = []string{}
	}

	transformationDataJSON, err := json.Marshal(book.TransformationData)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO books (id, url, title, authors, thumbnail_url, transformation_data, visibility, owner_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (id) DO UPDATE
		SET url = EXCLUDED.url,
			title = EXCLUDED.title,
			authors = EXCLUDED.authors,
			thumbnail_url = EXCLUDED.thumbnail_url,
			transformation_data = EXCLUDED.transformation_data,
			visibility = EXCLUDED.visibility,
			owner_user_id = EXCLUDED.owner_user_id,
			updated_at = NOW()
	`, book.ID, book.URL, book.Title, book.Authors, book.ThumbnailURL, transformationDataJSON, book.Visibility, book.OwnerUserID)
	return err
}

func (r *BookRepository) ExistsByURL(ctx context.Context, url string) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM books WHERE url = $1)`, url).Scan(&exists)
	return exists, err
}

func (r *BookRepository) ExistsByID(ctx context.Context, id uuid.UUID) (bool, error) {
	var exists bool
	err := r.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM books WHERE id = $1)`, id).Scan(&exists)
	return exists, err
}
