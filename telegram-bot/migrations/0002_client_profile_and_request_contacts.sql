ALTER TABLE clients ADD COLUMN telegram_username TEXT;
ALTER TABLE clients ADD COLUMN email TEXT;
ALTER TABLE service_requests ADD COLUMN telegram_username TEXT;
ALTER TABLE service_requests ADD COLUMN email TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_telegram_username ON clients(telegram_username, status);
