-- +migrate Up
CREATE TABLE IF NOT EXISTS transform_jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    dest_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transform_jobs_book_id ON transform_jobs(book_id);
CREATE INDEX IF NOT EXISTS idx_transform_jobs_status ON transform_jobs(status);

-- +migrate Down
DROP TABLE IF EXISTS transform_jobs;
