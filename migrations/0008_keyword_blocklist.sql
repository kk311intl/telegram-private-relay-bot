ALTER TABLE bot_settings ADD COLUMN blocked_keywords TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bot_settings ADD COLUMN keywords_message_id INTEGER NOT NULL DEFAULT 0;
