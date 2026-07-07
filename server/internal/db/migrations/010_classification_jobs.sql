-- +migrate Up
CREATE TABLE IF NOT EXISTS classification_jobs (
    book_id UUID PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_classification_jobs_status
    ON classification_jobs(status);

-- +migrate Down
DROP TABLE IF EXISTS classification_jobs;
