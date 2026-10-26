ALTER TABLE users ADD COLUMN language TEXT CHECK (language IN ('zh', 'en', 'ja'));
ALTER TABLE users ADD COLUMN language_message_id INTEGER NOT NULL DEFAULT 0;
