-- +migrate Up
ALTER TABLE books
    ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public',
    ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_books_visibility ON books(visibility);
CREATE INDEX IF NOT EXISTS idx_books_owner_user_id ON books(owner_user_id);

-- +migrate Down
ALTER TABLE books
    DROP COLUMN IF EXISTS owner_user_id,
    DROP COLUMN IF EXISTS visibility;
