export const nowIso = () => new Date().toISOString();

export async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results ?? [];
}

export async function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export async function getSetting(db, key) {
  const row = await first(db, "SELECT setting_value FROM settings WHERE setting_key = ?", key);
  return row?.setting_value ?? null;
}

export async function setSetting(db, key, value) {
  const now = nowIso();
  await run(
    db,
    `INSERT INTO settings(setting_key, setting_value, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at`,
    key,
    String(value),
    now,
  );
}

export async function saveSession(db, telegramUserId, state) {
  await run(
    db,
    `INSERT INTO user_sessions(telegram_user_id, state_json, updated_at) VALUES(?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
    String(telegramUserId),
    JSON.stringify(state),
    nowIso(),
  );
}

export async function getSession(db, telegramUserId) {
  const row = await first(db, "SELECT state_json, updated_at FROM user_sessions WHERE telegram_user_id = ?", String(telegramUserId));
  if (!row?.state_json) return null;
  if (!row.updated_at || Date.now() - Date.parse(row.updated_at) > 86_400_000) {
    await clearSession(db, telegramUserId);
    return null;
  }
  try {
    return JSON.parse(row.state_json);
  } catch {
    await clearSession(db, telegramUserId);
    return null;
  }
}

export async function clearSession(db, telegramUserId) {
  await run(db, "DELETE FROM user_sessions WHERE telegram_user_id = ?", String(telegramUserId));
}

export async function queueOutbox(db, {
  dedupeKey,
  target,
  chatId = null,
  method = "sendMessage",
  payload,
  category = "notification",
  serviceId = null,
  periodEnd = null,
}) {
  const now = nowIso();
  const result = await run(
    db,
    `INSERT OR IGNORE INTO outbox(
      dedupe_key, target, chat_id, method, payload_json, category, service_id,
      period_end, status, attempts, next_attempt_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    String(dedupeKey),
    target,
    chatId == null ? null : String(chatId),
    method,
    JSON.stringify(payload),
    category,
    serviceId,
    periodEnd,
    now,
    now,
  );
  if (result.meta?.changes) return result.meta.last_row_id;
  const existing = await first(db, "SELECT id FROM outbox WHERE dedupe_key = ?", String(dedupeKey));
  return existing?.id ?? null;
}

export async function audit(db, {
  actorTelegramId = null,
  action,
  entityType = null,
  entityId = null,
  details = {},
}) {
  const createdAt = nowIso();
  const result = await run(
    db,
    `INSERT INTO audit_events(actor_telegram_id, action, entity_type, entity_id, details_json, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    actorTelegramId == null ? null : String(actorTelegramId),
    action,
    entityType,
    entityId == null ? null : String(entityId),
    JSON.stringify(details),
    createdAt,
  );
  return { id: result.meta?.last_row_id ?? null, createdAt };
}
