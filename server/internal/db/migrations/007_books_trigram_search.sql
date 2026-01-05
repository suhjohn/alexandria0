-- +migrate Up
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Postgres requires index expressions to use IMMUTABLE functions. array_to_string()
-- is not marked IMMUTABLE, so we wrap it for use in the trigram index.
CREATE OR REPLACE FUNCTION immutable_array_to_string(text[], text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$ SELECT array_to_string($1, $2); $$;

-- Trigram indexes for fuzzy search over title/authors.
CREATE INDEX IF NOT EXISTS idx_books_title_trgm ON books USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_books_authors_trgm ON books USING gin ((immutable_array_to_string(authors, ' ')) gin_trgm_ops);

-- +migrate Down
-- (no-op) We intentionally keep extensions/indexes in place for local dev.
