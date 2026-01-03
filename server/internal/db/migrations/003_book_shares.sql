-- +migrate Up
CREATE TABLE IF NOT EXISTS book_shares (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    book_id UUID NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_shares_book_email
    ON book_shares(book_id, email);
CREATE INDEX IF NOT EXISTS idx_book_shares_email
    ON book_shares(email);

-- +migrate Down
DROP TABLE IF EXISTS book_shares;
