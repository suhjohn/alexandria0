-- +migrate Up
ALTER TABLE books
    ADD COLUMN IF NOT EXISTS source_size_bytes BIGINT NOT NULL DEFAULT 0;

-- +migrate Down
ALTER TABLE books
    DROP COLUMN IF EXISTS source_size_bytes;
