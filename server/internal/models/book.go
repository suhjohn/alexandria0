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
	SourceSizeBytes    int64               `json:"source_size_bytes"`
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

type BookCursor struct {
	Rank      float64   `json:"rank"`
	CreatedAt time.Time `json:"created_at"`
	ID        uuid.UUID `json:"id"`
}

type BookSearchResult struct {
	Books      []Book
	Total      int
	NextCursor *BookCursor
}

func (r *BookRepository) GetAll(ctx context.Context) ([]Book, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at
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
			&book.SourceSizeBytes,
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

func (r *BookRepository) SearchPublic(ctx context.Context, query string, limit int, cursor *BookCursor) (*BookSearchResult, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var total int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM books
		WHERE visibility = 'public'
		  AND (
				$1 = ''
				OR title % $1
				OR immutable_array_to_string(authors, ' ') % $1
				OR title ILIKE ('%' || $1 || '%')
				OR immutable_array_to_string(authors, ' ') ILIKE ('%' || $1 || '%')
			)
	`, query).Scan(&total)
	if err != nil {
		return nil, err
	}

	cursorRank := 0.0
	cursorCreatedAt := time.Time{}
	cursorID := uuid.Nil
	hasCursor := false
	if cursor != nil {
		cursorRank = cursor.Rank
		cursorCreatedAt = cursor.CreatedAt
		cursorID = cursor.ID
		hasCursor = true
	}

	rows, err := r.pool.Query(ctx, `
		WITH ranked AS (
			SELECT
				id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at,
				CASE
					WHEN $1 = '' THEN 0
					ELSE GREATEST(
						similarity(title, $1),
						similarity(immutable_array_to_string(authors, ' '), $1)
					)
				END AS rank
			FROM books
			WHERE visibility = 'public'
			  AND (
					$1 = ''
					OR title % $1
					OR immutable_array_to_string(authors, ' ') % $1
					OR title ILIKE ('%' || $1 || '%')
					OR immutable_array_to_string(authors, ' ') ILIKE ('%' || $1 || '%')
				)
		)
		SELECT
			id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at, rank
		FROM ranked
		WHERE ($3::bool = false) OR ((rank, created_at, id) < ($4, $5, $6))
		ORDER BY rank DESC, created_at DESC, id DESC
		LIMIT $2
	`, query, limit+1, hasCursor, cursorRank, cursorCreatedAt, cursorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []Book
	var nextCursor *BookCursor
	for rows.Next() {
		var book Book
		var transformationDataJSON []byte
		var rank float64
		err := rows.Scan(
			&book.ID,
			&book.URL,
			&book.Title,
			&book.Authors,
			&book.ThumbnailURL,
			&transformationDataJSON,
			&book.SourceSizeBytes,
			&book.Visibility,
			&book.OwnerUserID,
			&book.CreatedAt,
			&book.UpdatedAt,
			&rank,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
			book.TransformationData = make(map[string][]string)
		}

		books = append(books, book)
		if len(books) == limit {
			nextCursor = &BookCursor{
				Rank:      rank,
				CreatedAt: book.CreatedAt,
				ID:        book.ID,
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(books) > limit {
		books = books[:limit]
	} else {
		nextCursor = nil
	}

	if books == nil {
		books = []Book{}
	}

	return &BookSearchResult{Books: books, Total: total, NextCursor: nextCursor}, nil
}

func (r *BookRepository) SearchPersonal(
	ctx context.Context,
	userID uuid.UUID,
	email string,
	query string,
	limit int,
	cursor *BookCursor,
) (*BookSearchResult, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	normalized := NormalizeEmail(email)
	var total int
	err := r.pool.QueryRow(ctx, `
		SELECT COUNT(DISTINCT b.id)
		FROM books b
		LEFT JOIN book_shares bs ON bs.book_id = b.id AND bs.email = $2
		WHERE (b.owner_user_id = $1 OR bs.email IS NOT NULL)
		  AND (
				$3 = ''
				OR b.title % $3
				OR immutable_array_to_string(b.authors, ' ') % $3
				OR b.title ILIKE ('%' || $3 || '%')
				OR immutable_array_to_string(b.authors, ' ') ILIKE ('%' || $3 || '%')
			)
	`, userID, normalized, query).Scan(&total)
	if err != nil {
		return nil, err
	}

	cursorRank := 0.0
	cursorCreatedAt := time.Time{}
	cursorID := uuid.Nil
	hasCursor := false
	if cursor != nil {
		cursorRank = cursor.Rank
		cursorCreatedAt = cursor.CreatedAt
		cursorID = cursor.ID
		hasCursor = true
	}

	rows, err := r.pool.Query(ctx, `
		WITH ranked AS (
			SELECT
				b.id, b.url, b.title, b.authors, b.thumbnail_url, b.transformation_data, b.source_size_bytes,
				b.visibility, b.owner_user_id, b.created_at, b.updated_at,
				CASE
					WHEN $3 = '' THEN 0
					ELSE GREATEST(
						similarity(b.title, $3),
						similarity(immutable_array_to_string(b.authors, ' '), $3)
					)
				END AS rank
			FROM books b
			LEFT JOIN book_shares bs ON bs.book_id = b.id AND bs.email = $2
			WHERE (b.owner_user_id = $1 OR bs.email IS NOT NULL)
			  AND (
					$3 = ''
					OR b.title % $3
					OR immutable_array_to_string(b.authors, ' ') % $3
					OR b.title ILIKE ('%' || $3 || '%')
					OR immutable_array_to_string(b.authors, ' ') ILIKE ('%' || $3 || '%')
				)
		)
		SELECT
			id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at, rank
		FROM ranked
		WHERE ($4::bool = false) OR ((rank, created_at, id) < ($5, $6, $7))
		ORDER BY rank DESC, created_at DESC, id DESC
		LIMIT $8
	`, userID, normalized, query, hasCursor, cursorRank, cursorCreatedAt, cursorID, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var books []Book
	var nextCursor *BookCursor
	for rows.Next() {
		var book Book
		var transformationDataJSON []byte
		var rank float64
		err := rows.Scan(
			&book.ID,
			&book.URL,
			&book.Title,
			&book.Authors,
			&book.ThumbnailURL,
			&transformationDataJSON,
			&book.SourceSizeBytes,
			&book.Visibility,
			&book.OwnerUserID,
			&book.CreatedAt,
			&book.UpdatedAt,
			&rank,
		)
		if err != nil {
			return nil, err
		}

		if err := json.Unmarshal(transformationDataJSON, &book.TransformationData); err != nil {
			book.TransformationData = make(map[string][]string)
		}

		books = append(books, book)
		if len(books) == limit {
			nextCursor = &BookCursor{
				Rank:      rank,
				CreatedAt: book.CreatedAt,
				ID:        book.ID,
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(books) > limit {
		books = books[:limit]
	} else {
		nextCursor = nil
	}

	if books == nil {
		books = []Book{}
	}

	return &BookSearchResult{Books: books, Total: total, NextCursor: nextCursor}, nil
}

func (r *BookRepository) GetAllPublic(ctx context.Context) ([]Book, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at
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
			&book.SourceSizeBytes,
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
		SELECT DISTINCT b.id, b.url, b.title, b.authors, b.thumbnail_url, b.transformation_data, b.source_size_bytes,
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
			&book.SourceSizeBytes,
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
		SELECT id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id, created_at, updated_at
		FROM books
		WHERE id = $1
	`, id).Scan(
		&book.ID,
		&book.URL,
		&book.Title,
		&book.Authors,
		&book.ThumbnailURL,
		&transformationDataJSON,
		&book.SourceSizeBytes,
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

func (r *BookRepository) DeleteOwned(ctx context.Context, id uuid.UUID, ownerUserID uuid.UUID) (bool, error) {
	tag, err := r.pool.Exec(ctx, `
		DELETE FROM books
		WHERE id = $1 AND owner_user_id = $2
	`, id, ownerUserID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
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
	if book.SourceSizeBytes < 0 {
		book.SourceSizeBytes = 0
	}

	transformationDataJSON, err := json.Marshal(book.TransformationData)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO books (id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, book.ID, book.URL, book.Title, book.Authors, book.ThumbnailURL, transformationDataJSON, book.SourceSizeBytes, book.Visibility, book.OwnerUserID)

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
	if book.SourceSizeBytes < 0 {
		book.SourceSizeBytes = 0
	}

	transformationDataJSON, err := json.Marshal(book.TransformationData)
	if err != nil {
		return err
	}

	_, err = r.pool.Exec(ctx, `
		INSERT INTO books (id, url, title, authors, thumbnail_url, transformation_data, source_size_bytes, visibility, owner_user_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (id) DO UPDATE
		SET url = EXCLUDED.url,
			title = EXCLUDED.title,
			authors = EXCLUDED.authors,
			thumbnail_url = EXCLUDED.thumbnail_url,
			transformation_data = EXCLUDED.transformation_data,
			source_size_bytes = EXCLUDED.source_size_bytes,
			visibility = EXCLUDED.visibility,
			owner_user_id = EXCLUDED.owner_user_id,
			updated_at = NOW()
	`, book.ID, book.URL, book.Title, book.Authors, book.ThumbnailURL, transformationDataJSON, book.SourceSizeBytes, book.Visibility, book.OwnerUserID)
	return err
}

func (r *BookRepository) TotalSourceBytesForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var total int64
	err := r.pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(source_size_bytes), 0)
		FROM books
		WHERE owner_user_id = $1
	`, userID).Scan(&total)
	return total, err
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
