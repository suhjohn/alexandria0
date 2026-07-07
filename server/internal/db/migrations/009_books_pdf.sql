-- +migrate Up
ALTER TABLE books
    ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'epub',
    ADD COLUMN IF NOT EXISTS pdf_has_text_layer BOOLEAN,
    ADD COLUMN IF NOT EXISTS page_count INTEGER;

-- +migrate Down
ALTER TABLE books
    DROP COLUMN IF EXISTS page_count,
    DROP COLUMN IF EXISTS pdf_has_text_layer,
    DROP COLUMN IF EXISTS format;
