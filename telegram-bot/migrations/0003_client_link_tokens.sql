CREATE TABLE IF NOT EXISTS client_link_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  expected_username TEXT NOT NULL,
  created_by_telegram_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_telegram_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_link_tokens_client ON client_link_tokens(client_id, expires_at, used_at);
