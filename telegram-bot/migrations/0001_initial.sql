PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL CHECK(length(full_name) BETWEEN 1 AND 160),
  phone TEXT,
  telegram_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_telegram ON clients(telegram_user_id);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status, id);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  site_name TEXT NOT NULL CHECK(length(site_name) BETWEEN 1 AND 160),
  site_url TEXT NOT NULL CHECK(length(site_url) <= 500),
  monthly_price_minor INTEGER NOT NULL CHECK(monthly_price_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB' CHECK(length(currency) = 3),
  valid_through TEXT NOT NULL CHECK(length(valid_through) = 10),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid', 'pending', 'paid')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_services_client ON services(client_id, status, id);
CREATE INDEX IF NOT EXISTS idx_services_due ON services(status, valid_through, payment_status);

CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  site_url TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'handled', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON service_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER REFERENCES clients(id),
  service_id INTEGER REFERENCES services(id),
  period_end TEXT,
  telegram_user_id TEXT NOT NULL,
  source_chat_id TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('photo', 'document')),
  amount_minor INTEGER CHECK(amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  archive_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_service ON receipts(service_id, period_end);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER REFERENCES services(id),
  receipt_id INTEGER REFERENCES receipts(id),
  action TEXT NOT NULL CHECK(action IN ('receipt_submitted', 'approved', 'rejected', 'manual_approved')),
  amount_minor INTEGER CHECK(amount_minor IS NULL OR amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  period_end_before TEXT,
  period_end_after TEXT,
  actor_telegram_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_events_service ON payment_events(service_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_telegram_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  telegram_user_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reminder_sends (
  service_id INTEGER NOT NULL REFERENCES services(id),
  period_end TEXT NOT NULL,
  milestone TEXT NOT NULL CHECK(milestone IN ('before_3_days', 'end_day', 'after_1_day')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'sent', 'cancelled', 'failed')),
  outbox_id INTEGER,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY(service_id, period_end, milestone)
);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminder_sends(status, created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL CHECK(target IN ('admin', 'archive', 'user')),
  chat_id TEXT,
  method TEXT NOT NULL CHECK(method IN ('sendMessage', 'copyMessage')),
  payload_json TEXT NOT NULL,
  category TEXT NOT NULL,
  service_id INTEGER,
  period_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'cancelled', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_outbox_reminder ON outbox(category, service_id, period_end, status);
