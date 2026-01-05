-- +migrate Up
ALTER TABLE transform_jobs
ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT 'modernify';

DROP INDEX IF EXISTS idx_transform_jobs_book_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_jobs_book_id_variant
    ON transform_jobs(book_id, variant);

-- +migrate Down
DROP INDEX IF EXISTS idx_transform_jobs_book_id_variant;

ALTER TABLE transform_jobs
DROP COLUMN IF EXISTS variant;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_jobs_book_id
    ON transform_jobs(book_id);
