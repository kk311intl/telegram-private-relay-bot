ALTER TABLE bot_settings ADD COLUMN block_notice INTEGER NOT NULL DEFAULT 1 CHECK (block_notice IN (0, 1));
ALTER TABLE bot_settings ADD COLUMN block_notice_message_id INTEGER NOT NULL DEFAULT 0;
