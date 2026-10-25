ALTER TABLE users ADD COLUMN captcha_verified INTEGER NOT NULL DEFAULT 0 CHECK (captcha_verified IN (0, 1));
ALTER TABLE users ADD COLUMN captcha_code INTEGER;
ALTER TABLE users ADD COLUMN captcha_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN captcha_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN captcha_last_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN captcha_message_id INTEGER NOT NULL DEFAULT 0;

-- Existing contacts keep access; erased profiles must verify when they return.
UPDATE users SET captcha_verified = 1 WHERE erased = 0;

CREATE TABLE bot_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  captcha_enabled INTEGER CHECK (captcha_enabled IN (0, 1)),
  captcha_message_id INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bot_settings(id) VALUES (1);
