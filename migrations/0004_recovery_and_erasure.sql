ALTER TABLE users ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN erased INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN forgotten_message_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN forgotten_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN topic_lease_token TEXT;

ALTER TABLE media_groups ADD COLUMN user_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE media_groups ADD COLUMN lease_token TEXT;
ALTER TABLE processed_updates ADD COLUMN lease_token TEXT;

CREATE TABLE IF NOT EXISTS rate_admissions (
  user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  rate_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, generation, rate_key)
);
CREATE INDEX IF NOT EXISTS idx_rate_admissions_created ON rate_admissions(created_at);
