-- +migrate Up
ALTER TABLE transform_jobs
ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT 'modernify';

DROP INDEX IF EXISTS idx_transform_jobs_book_id;

-- Ensure existing data matches the (book_id, variant) uniqueness expectation.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY book_id, variant
            ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS rn
    FROM transform_jobs
)
DELETE FROM transform_jobs t
USING ranked r
WHERE t.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_jobs_book_id_variant
    ON transform_jobs(book_id, variant);

-- +migrate Down
DROP INDEX IF EXISTS idx_transform_jobs_book_id_variant;

ALTER TABLE transform_jobs
DROP COLUMN IF EXISTS variant;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_jobs_book_id
    ON transform_jobs(book_id);
