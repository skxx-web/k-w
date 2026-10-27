import {
  addMonthsClamped,
  cleanText,
  csvSafeFilenamePart,
  daysBetween,
  formatMoney,
  isValidEmail,
  isIsoDate,
  isSafeHttpUrl,
  normalizeTelegramUsername,
  localDateString,
  parseMoneyMinor,
  reminderMilestones,
  renewalDate,
  toCsv,
} from "./domain.js";
import { all, audit, clearSession, first, getSession, getSetting, nowIso, queueOutbox, run, saveSession, setSetting } from "./storage.js";
import { constantTimeEqual, TelegramApiError, telegramApi, telegramSendDocument } from "./telegram-api.js";

const MAX_MESSAGE = 3800;
const OUTBOX_MAX_ATTEMPTS = 8;
const PRIVATE_ONLY = "Эту команду можно использовать только в личном чате с ботом.";

const ADMIN_MENU = {
  inline_keyboard: [
    [
      { text: "Клиенты", callback_data: "clients:1" },
      { text: "Добавить клиента", callback_data: "client:add" },
    ],
    [
      { text: "Сайты и подписки", callback_data: "services:1" },
      { text: "Чеки и оплаты", callback_data: "payments:1" },
    ],
    [
      { text: "Заявки", callback_data: "requests:1" },
      { text: "Журнал", callback_data: "history" },
    ],
    [
      { text: "CSV клиентов", callback_data: "export:csv" },
      { text: "Резервная копия", callback_data: "backup" },
    ],
    [{ text: "Мои реквизиты", callback_data: "admin:requisites" }],
    [{ text: "Предпросмотр клиента", callback_data: "admin:preview" }],
  ],
};

const USER_MENU = {
  inline_keyboard: [
    [{ text: "Оставить заявку", callback_data: "request:start" }],
    [{ text: "Проверить подписку", callback_data: "cabinet" }],
    [{ text: "Запросить реквизиты для оплаты", callback_data: "receipt:start" }],
  ],
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function plainResponse(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function adminIds(env) {
  return String(env.TELEGRAM_ADMIN_IDS ?? env.TELEGRAM_ADMIN_ID ?? "")
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^\d{4,20}$/.test(value));
}

function isAdmin(userId, env) {
  const id = String(userId ?? "");
  return id.length > 0 && adminIds(env).includes(id);
}

function isGroupChat(chat) {
  return chat?.type === "group" || chat?.type === "supergroup";
}

function button(text, callbackData) {
  return { text, callback_data: callbackData };
}

function userChatId(message) {
  return message?.chat?.id == null ? null : String(message.chat.id);
}

function randomKey(prefix) {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function enqueueText(env, { target, chatId = null, key, text, keyboard = null, category = "notification", serviceId = null, periodEnd = null }) {
  const payload = { text: cleanText(text, MAX_MESSAGE) };
  if (keyboard) payload.reply_markup = keyboard;
  if (target === "user" && chatId != null) payload.chat_id = String(chatId);
  return queueOutbox(env.DB, {
    dedupeKey: key,
    target,
    chatId,
    method: "sendMessage",
    payload,
    category,
    serviceId,
    periodEnd,
  });
}

async function enqueueAdmins(env, key, text, keyboard = null, category = "admin_notice") {
  const recipients = adminIds(env);
  for (const id of recipients) {
    await enqueueText(env, {
      target: "admin",
      chatId: id,
      key: `${key}:admin:${id}`,
      text,
      keyboard,
      category,
    });
  }
}

async function enqueueAdminsCopy(env, { key, fromChatId, messageId, caption, keyboard, category, serviceId = null, periodEnd = null }) {
  for (const id of adminIds(env)) {
    await queueOutbox(env.DB, {
      dedupeKey: `${key}:admin:${id}`,
      target: "admin",
      chatId: id,
      method: "copyMessage",
      payload: {
        from_chat_id: String(fromChatId),
        message_id: Number(messageId),
        caption: cleanText(caption, 900),
        reply_markup: keyboard,
      },
      category,
      serviceId,
      periodEnd,
    });
  }
}

async function enqueueArchive(env, key, text, category = "archive_event", serviceId = null, periodEnd = null) {
  return queueOutbox(env.DB, {
    dedupeKey: key,
    target: "archive",
    method: "sendMessage",
    payload: { text: cleanText(text, MAX_MESSAGE) },
    category,
    serviceId,
    periodEnd,
  });
}

async function enqueueArchiveCopy(env, { key, fromChatId, messageId, caption, serviceId = null, periodEnd = null, receiptId }) {
  return queueOutbox(env.DB, {
    dedupeKey: key,
    target: "archive",
    method: "copyMessage",
    payload: {
      from_chat_id: String(fromChatId),
      message_id: Number(messageId),
      caption: cleanText(caption, 900),
    },
    category: `receipt_copy:${receiptId}`,
    serviceId,
    periodEnd,
  });
}

async function recordEvent(env, {
  actorId = null,
  action,
  entityType = null,
  entityId = null,
  details = {},
  archiveText = null,
  archiveKey = null,
}) {
  const event = await audit(env.DB, {
    actorTelegramId: actorId,
    action,
    entityType,
    entityId,
    details,
  });
  if (archiveText) {
    await enqueueArchive(env, archiveKey || `audit:${event.id}`, archiveText, "archive_event");
  }
  return event;
}

async function sendUserText(env, updateId, chatId, text, keyboard = null, category = "reply") {
  return enqueueText(env, {
    target: "user",
    chatId,
    key: `update:${updateId}:${category}:${chatId}`,
    text,
    keyboard,
    category,
  });
}

function backToAdmin() {
  return [[button("В меню", "menu:admin")]];
}

function inline(rows) {
  return { inline_keyboard: rows };
}

async function displayAdminMenu(env, updateId, chatId, text = "K web — обслуживание сайтов\nВыберите действие:") {
  return sendUserText(env, updateId, chatId, text, ADMIN_MENU, "admin_menu");
}

async function displayUserMenu(env, updateId, chatId, text = "Здравствуйте! Чем помочь?") {
  return sendUserText(env, updateId, chatId, text, USER_MENU, "user_menu");
}

function clientWelcomeText(services) {
  const today = localDateString();
  if (!services.length) return "Здравствуйте!\nПодписка не активна. Чтобы узнать условия оплаты, запросите реквизиты.";
  const lines = services.map((service) => {
    const active = service.valid_through >= today;
    const status = active ? `Подписка активна до ${service.valid_through}.` : `Подписка не активна — срок закончился ${service.valid_through}.`;
    const receipt = Number(service.pending_receipts || 0) > 0 ? " Чек получен и ожидает проверки." : "";
    return `${status}${receipt}`;
  });
  return `Здравствуйте!\n\n${lines.join("\n")}`;
}

async function showPaymentRequisites(env, updateId, chatId) {
  const requisites = await getSetting(env.DB, "payment_requisites");
  const text = requisites
    ? `Мои реквизиты для оплаты:\n\n${requisites}`
    : "Реквизиты пока не заданы. Отправьте их следующим сообщением, чтобы добавить или изменить.";
  return sendUserText(env, updateId, chatId, text, inline([
    [button(requisites ? "Изменить реквизиты" : "Добавить реквизиты", "admin:requisites:edit")],
    ...(requisites ? [[button("Очистить реквизиты", "admin:requisites:clear")]] : []),
    [button("В меню", "menu:admin")],
  ]), "admin_requisites");
}

async function processOutbox(env, limit = 20) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
  const now = new Date();
  const nowText = now.toISOString();
  const staleLock = new Date(now.getTime() - 120_000).toISOString();
  const rows = await all(
    env.DB,
    `SELECT * FROM outbox
     WHERE status = 'pending' AND next_attempt_at <= ?
       AND (locked_until IS NULL OR locked_until < ?)
     ORDER BY id ASC LIMIT ?`,
    nowText,
    nowText,
    limit,
  );

  for (const row of rows) {
    const lease = new Date(Date.now() + 120_000).toISOString();
    const claim = await run(
      env.DB,
      `UPDATE outbox SET locked_until = ?
       WHERE id = ? AND status = 'pending' AND (locked_until IS NULL OR locked_until < ?)`,
      lease,
      row.id,
      staleLock,
    );
    if (!claim.meta?.changes) continue;

    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      await run(env.DB, "UPDATE outbox SET status='failed', locked_until=NULL, last_error='invalid_payload' WHERE id=?", row.id);
      continue;
    }

    let destination = row.chat_id;
    if (row.target === "archive") destination = await getSetting(env.DB, "archive_chat_id");
    if (row.target === "admin" && !destination) destination = adminIds(env)[0] ?? null;
    if (!destination) {
      await run(env.DB, "UPDATE outbox SET locked_until=NULL WHERE id=?", row.id);
      continue;
    }

    payload.chat_id = String(destination);
    try {
      const result = await telegramApi(env, row.method, payload);
      const sentAt = nowIso();
      await run(
        env.DB,
        `UPDATE outbox SET status='sent', sent_at=?, locked_until=NULL, last_error=NULL, payload_json='{}'
         WHERE id=? AND status='pending'`,
        sentAt,
        row.id,
      );
      if (row.category?.startsWith("receipt_copy:")) {
        const receiptId = Number(row.category.split(":")[1]);
        if (Number.isInteger(receiptId)) {
          await run(
            env.DB,
            "UPDATE receipts SET archive_message_id=?, updated_at=? WHERE id=?",
            Number(result?.message_id) || null,
            sentAt,
            receiptId,
          );
        }
      }
      if (row.category === "reminder" && row.service_id && row.period_end) {
        const milestone = row.dedupe_key.split(":").at(-1);
        await run(
          env.DB,
          `UPDATE reminder_sends SET status='sent', sent_at=?
           WHERE service_id=? AND period_end=? AND milestone=? AND status='queued'`,
          sentAt,
          row.service_id,
          row.period_end,
          milestone,
        );
      }
    } catch (error) {
      const attempts = Number(row.attempts || 0) + 1;
      const retrySeconds = error instanceof TelegramApiError && error.retryAfter
        ? Math.max(5, Math.min(error.retryAfter, 21_600))
        : Math.min(21_600, 60 * (2 ** Math.min(attempts - 1, 8)));
      const nextAt = new Date(Date.now() + retrySeconds * 1000).toISOString();
      const isFinal = attempts >= OUTBOX_MAX_ATTEMPTS;
      const safeError = error instanceof TelegramApiError
        ? `telegram_${error.errorCode || "error"}:${cleanText(error.message, 140)}`
        : "delivery_failed";
      await run(
        env.DB,
        `UPDATE outbox SET attempts=?, next_attempt_at=?, locked_until=NULL,
           status=?, last_error=? WHERE id=? AND status='pending'`,
        attempts,
        nextAt,
        isFinal ? "failed" : "pending",
        safeError,
        row.id,
      );
      if (isFinal && row.target !== "admin" && row.category !== "delivery_error") {
        await enqueueAdmins(
          env,
          `outbox-failed:${row.id}`,
          `Не удалось доставить сообщение Telegram после ${OUTBOX_MAX_ATTEMPTS} попыток. Категория: ${cleanText(row.category, 60)}. Проверьте чат/права бота.`,
          null,
          "delivery_error",
        );
      }
      if (isFinal && row.category === "reminder" && row.service_id && row.period_end) {
        const milestone = row.dedupe_key.split(":").at(-1);
        await run(
          env.DB,
          `UPDATE reminder_sends SET status='failed'
           WHERE service_id=? AND period_end=? AND milestone=? AND status='queued'`,
          row.service_id,
          row.period_end,
          milestone,
        );
      }
    }
  }
}

async function handleStart(env, updateId, message) {
  const chatId = userChatId(message);
  const userId = String(message.from?.id ?? "");
  if (!chatId || !userId || message.chat?.type !== "private") {
    if (chatId) await sendUserText(env, updateId, chatId, PRIVATE_ONLY);
    return;
  }
  await clearSession(env.DB, userId);
  if (isAdmin(userId, env)) {
    await displayAdminMenu(env, updateId, chatId);
  } else {
    const linked = await first(env.DB, "SELECT id FROM clients WHERE telegram_user_id=? AND status='active' LIMIT 1", userId);
    if (linked) return showClientCabinet(env, updateId, chatId, userId);
    await displayUserMenu(env, updateId, chatId, "Здравствуйте! Чтобы подключить обслуживание, оставьте заявку.");
  }
}

async function startClientRequest(env, updateId, chatId, userId) {
  await saveSession(env.DB, userId, { flow: "request", step: "name", data: {} });
  await sendUserText(
    env,
    updateId,
    chatId,
    "Регистрация заявки. Напишите ваше имя. Telegram-ник подставится автоматически, также понадобится e-mail. Данные увидят администратор и закрытая архивная группа K web.",
    null,
    "request_prompt",
  );
}

async function startReceiptFlow(env, updateId, chatId, userId) {
  const client = await first(env.DB, "SELECT id FROM clients WHERE telegram_user_id=? AND status='active'", String(userId));
  if (!client) return sendUserText(env, updateId, chatId, "Кабинет ещё не подключён. Сначала отправьте заявку; администратор проверит данные и откроет доступ.", USER_MENU, "receipt_not_authorized");
  const services = await all(env.DB, "SELECT id, site_name, valid_through FROM services WHERE client_id=? AND status='active' ORDER BY id DESC", client.id);
  if (!services.length) return sendUserText(env, updateId, chatId, "У вас пока нет активных сайтов для оплаты.", inline([[button("Мой кабинет", "cabinet"), button("В меню", "menu:user")]]), "receipt_no_services");
  if (services.length === 1) return startReceiptForService(env, updateId, chatId, userId, services[0].id);
  const rows = services.map((service) => [button(`${service.site_name} · до ${service.valid_through}`, `receipt:service:${service.id}`)]);
  rows.push([button("Назад", "cabinet")]);
  return sendUserText(env, updateId, chatId, "Выберите подписку, за которую хотите оплатить. После выбора появятся реквизиты и кнопка для отправки подтверждения оплаты.", inline(rows), "receipt_service_picker");
}

async function startReceiptForService(env, updateId, chatId, userId, serviceId) {
  const service = await first(
    env.DB,
    `SELECT s.id, s.site_name, s.valid_through FROM services s
     JOIN clients c ON c.id=s.client_id
     WHERE s.id=? AND s.status='active' AND c.status='active' AND c.telegram_user_id=?`,
    Number(serviceId),
    String(userId),
  );
  if (!service) return sendUserText(env, updateId, chatId, "Этот сайт не привязан к вашему кабинету.", inline([[button("Мой кабинет", "cabinet")]]), "receipt_service_denied");
  const requisites = await getSetting(env.DB, "payment_requisites");
  if (!requisites) return sendUserText(env, updateId, chatId, "Реквизиты пока не настроены. Пожалуйста, обратитесь к администратору.", inline([[button("Назад", "cabinet")]]), "payment_requisites_missing");
  await saveSession(env.DB, userId, { flow: "receipt", step: "await_upload", data: { service_id: service.id } });
  return sendUserText(env, updateId, chatId, `Реквизиты для оплаты:\n\n${requisites}\n\nПосле оплаты нажмите кнопку ниже и приложите подтверждение.`, inline([
    [button("Предоставить изображение или файл", "receipt:upload")],
  ]), "payment_requisites");
}

async function startReceiptUpload(env, updateId, chatId, userId) {
  const session = await getSession(env.DB, userId);
  if (session?.flow !== "receipt" || session.step !== "await_upload" || !session.data?.service_id) {
    return sendUserText(env, updateId, chatId, "Сначала запросите реквизиты и выберите подписку.", inline([[button("Запросить реквизиты", "receipt:start")]]), "receipt_upload_stale");
  }
  await saveSession(env.DB, userId, { ...session, step: "proof" });
  return sendUserText(env, updateId, chatId, "Теперь прикрепите изображение или PDF-файл подтверждения оплаты. Другие сообщения не принимаются.", null, "receipt_upload_prompt");
}

async function showClientCabinet(env, updateId, chatId, userId) {
  const client = await first(env.DB, "SELECT * FROM clients WHERE telegram_user_id=? AND status='active' LIMIT 1", String(userId));
  if (!client) return sendUserText(env, updateId, chatId, "Доступ к кабинету пока не открыт. Оставьте заявку — после проверки администратор подключит профиль.", USER_MENU, "cabinet_not_authorized");
  const services = await all(
    env.DB,
    `SELECT s.valid_through,
       (SELECT COUNT(*) FROM receipts r WHERE r.service_id=s.id AND r.status='pending') AS pending_receipts
     FROM services s WHERE s.client_id=? AND s.status='active' ORDER BY s.id DESC LIMIT 12`,
    client.id,
  );
  return sendUserText(env, updateId, chatId, clientWelcomeText(services), inline([
    [button("Запросить реквизиты для оплаты", "receipt:start")],
    [button("Обновить", "cabinet")],
  ]), "client_cabinet");
}

async function showClientPreviewList(env, updateId, chatId) {
  const clients = await all(env.DB, "SELECT id, full_name FROM clients WHERE status='active' ORDER BY full_name COLLATE NOCASE LIMIT 20");
  if (!clients.length) {
    return sendUserText(env, updateId, chatId, "Пока нет активных клиентских профилей для предпросмотра. Предпросмотр ничего не отправляет клиентам и не меняет данные.", inline([[button("В меню", "menu:admin")]]), "admin_preview");
  }
  return sendUserText(env, updateId, chatId, "Выберите профиль, чтобы увидеть клиентское приветствие и статус подписки. Это только предпросмотр — клиенту ничего не отправится.", inline([
    ...clients.map((client) => [button(client.full_name, `admin:preview:client:${client.id}`)]),
    [button("В меню", "menu:admin")],
  ]), "admin_preview_list");
}

async function showClientPreview(env, updateId, chatId, clientId) {
  const client = await first(env.DB, "SELECT id, full_name FROM clients WHERE id=? AND status='active'", Number(clientId));
  if (!client) return sendUserText(env, updateId, chatId, "Клиент не найден или архивирован.", inline([[button("К списку", "admin:preview"), button("В меню", "menu:admin")]]), "admin_preview");
  const services = await all(env.DB, `SELECT s.valid_through,
      (SELECT COUNT(*) FROM receipts r WHERE r.service_id=s.id AND r.status='pending') AS pending_receipts
    FROM services s WHERE s.client_id=? AND s.status='active' ORDER BY s.id DESC LIMIT 12`, client.id);
  const text = `ПРЕДПРОСМОТР · ${client.full_name}\n\n${clientWelcomeText(services)}\n\nЭто отображение для клиента. Сообщение не отправлено клиенту.`;
  return sendUserText(env, updateId, chatId, text, inline([
    [button("Запросить реквизиты для оплаты", `admin:preview:req:${client.id}`)],
    [button("Обновить", `admin:preview:client:${client.id}`)],
    [button("К списку", "admin:preview")],
  ]), "admin_preview_client");
}

async function showPreviewRequisites(env, updateId, chatId, clientId) {
  const services = await all(env.DB, "SELECT id, site_name, valid_through FROM services WHERE client_id=? AND status='active' ORDER BY id DESC", Number(clientId));
  if (!services.length) return sendUserText(env, updateId, chatId, "У клиента нет активных подписок. В клиентском кабинете нечего оплачивать.", inline([[button("Назад", `admin:preview:client:${clientId}`)]]), "admin_preview_requisites");
  if (services.length > 1) return sendUserText(env, updateId, chatId, "В клиентском кабинете клиент сначала выберет подписку:", inline([
    ...services.map((service) => [button(`${service.site_name} · до ${service.valid_through}`, `admin:preview:reqservice:${clientId}:${service.id}`)]),
    [button("Назад", `admin:preview:client:${clientId}`)],
  ]), "admin_preview_requisites");
  return showPreviewServiceRequisites(env, updateId, chatId, clientId, services[0].id);
}

async function showPreviewServiceRequisites(env, updateId, chatId, clientId, serviceId) {
  const service = await first(env.DB, "SELECT id FROM services WHERE id=? AND client_id=? AND status='active'", Number(serviceId), Number(clientId));
  if (!service) return sendUserText(env, updateId, chatId, "Активная подписка не найдена.", inline([[button("Назад", `admin:preview:client:${clientId}`)]]), "admin_preview_requisites");
  const requisites = await getSetting(env.DB, "payment_requisites");
  if (!requisites) return sendUserText(env, updateId, chatId, "Реквизиты пока не настроены. Клиент увидит эту подсказку вместо платёжных данных.", inline([[button("Назад", `admin:preview:client:${clientId}`)]]), "admin_preview_requisites");
  return sendUserText(env, updateId, chatId, `ПРЕДПРОСМОТР · реквизиты для оплаты\n\n${requisites}\n\nПосле оплаты клиент прикладывает подтверждение. Реальной отправки клиенту нет.`, inline([
    [button("Предоставить изображение или файл", "admin:preview:upload")],
    [button("Назад", `admin:preview:client:${clientId}`)],
  ]), "admin_preview_requisites");
}

async function showPreviewUpload(env, updateId, chatId) {
  return sendUserText(env, updateId, chatId, "В настоящем клиентском чате после этой кнопки бот принимает только фотографию, изображение или PDF. В режиме предпросмотра загрузка отключена — файл не отправлен и оплата не зарегистрирована.", inline([[button("К экрану клиента", "admin:preview")], [button("В меню", "menu:admin")]]), "admin_preview_upload");
}

async function askPhone(env, updateId, chatId) {
  const keyboard = {
    keyboard: [[{ text: "Отправить мой номер", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
  await sendUserText(env, updateId, chatId, "Отправьте номер телефона или введите его текстом.", keyboard, "request_phone_prompt");
}

async function removeReplyKeyboard(env, updateId, chatId, text) {
  return enqueueText(env, {
    target: "user",
    chatId,
    key: `update:${updateId}:remove-keyboard:${chatId}`,
    text,
    keyboard: { remove_keyboard: true },
    category: "reply",
  });
}

async function finishClientRequest(env, updateId, message, state) {
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  const data = state.data;
  const now = nowIso();
  const result = await run(
    env.DB,
    `INSERT INTO service_requests(telegram_user_id, telegram_username, email, full_name, phone, site_url, details, status, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    userId,
    normalizeTelegramUsername(message.from?.username) ?? null,
    data.email ?? null,
    data.full_name,
    data.phone,
    data.site_url,
    data.details,
    now,
    now,
  );
  const requestId = Number(result.meta?.last_row_id);
  await clearSession(env.DB, userId);
  const telegramUsername = normalizeTelegramUsername(message.from?.username);
  const summary = `Новая заявка #${requestId}\nКлиент: ${data.full_name}\nТелефон: ${data.phone}\nTelegram: ${telegramUsername || "ник не задан"}\nE-mail: ${data.email}\nСайт: ${data.site_url}\nОписание: ${data.details}`;
  const event = await recordEvent(env, {
    actorId: userId,
    action: "service_request_submitted",
    entityType: "service_request",
    entityId: requestId,
    details: { requestId },
    archiveText: summary,
    archiveKey: `archive:request:${requestId}`,
  });
  await enqueueAdmins(env, `request:${requestId}`, summary, inline([[button("Открыть заявку", `request:view:${requestId}`)]]), "request_notice");
  await removeReplyKeyboard(env, updateId, chatId, "Заявка передана администратору. Реквизиты или ссылку для оплаты он отправит отдельно.");
  return event;
}

async function identifyService(env, userId, siteText) {
  const needle = cleanText(siteText, 500).toLowerCase();
  if (needle) {
    const match = await first(
      env.DB,
      `SELECT s.*, c.full_name, c.phone, c.telegram_user_id
       FROM services s JOIN clients c ON c.id=s.client_id
       WHERE s.status='active' AND c.status='active'
         AND (lower(s.site_name)=? OR lower(s.site_url)=?)
       ORDER BY s.id DESC LIMIT 1`,
      needle,
      needle,
    );
    if (match) return match;
  }
  const linked = await all(
    env.DB,
    `SELECT s.*, c.full_name, c.phone, c.telegram_user_id
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active' AND c.telegram_user_id=?
     ORDER BY s.id DESC LIMIT 2`,
    String(userId),
  );
  return linked.length === 1 ? linked[0] : null;
}

function receiptCaption({ receiptId, clientName, telegramUsername, email, siteName, siteUrl, periodEnd, amountMinor, note, lastPayment }) {
  return [
    `ЧЕК #${receiptId} — ОЖИДАЕТ ПРОВЕРКИ`,
    `Клиент: ${clientName || "не определён"}`,
    telegramUsername ? `Telegram: ${telegramUsername}` : null,
    email ? `E-mail: ${email}` : null,
    `Сайт: ${siteName || siteUrl || "не указан"}`,
    `Дата: ${localDateString()}`,
    periodEnd ? `Оплаченный период до: ${periodEnd}` : null,
    lastPayment ? `Последняя подтверждённая оплата: ${String(lastPayment.created_at).slice(0, 10)}${lastPayment.amount_minor == null ? "" : ` · ${formatMoney(lastPayment.amount_minor)}`}` : "Подтверждённых оплат пока нет",
    amountMinor == null ? "Сумма: не указана" : `Сумма: ${formatMoney(amountMinor)}`,
    note ? `Подпись клиента: ${cleanText(note, 180)}` : null,
  ].filter(Boolean).join("\n");
}

async function createReceipt(env, updateId, message, state, media) {
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  const data = state.data;
  const service = await first(
    env.DB,
    `SELECT s.*, c.full_name, c.phone, c.telegram_username, c.email
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.id=? AND s.status='active' AND c.status='active' AND c.telegram_user_id=?`,
    Number(data.service_id),
    userId,
  );
  if (!service) {
    await clearSession(env.DB, userId);
    return sendUserText(env, updateId, chatId, "Не удалось проверить ваш доступ к этому сайту. Откройте кабинет и выберите сайт заново.", inline([[button("Мой кабинет", "cabinet")]]), "receipt_owner_check");
  }
  const lastPayment = await first(
    env.DB,
    "SELECT created_at, amount_minor FROM payment_events WHERE service_id=? AND action IN ('approved','manual_approved') ORDER BY id DESC LIMIT 1",
    service.id,
  );
  const now = nowIso();
  const result = await run(
    env.DB,
    `INSERT INTO receipts(
      client_id, service_id, period_end, telegram_user_id, source_chat_id,
      source_message_id, file_id, media_type, amount_minor, currency, status, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUB', 'pending', ?, ?)`,
    service.client_id,
    service.id,
    service.valid_through,
    userId,
    String(message.chat.id),
    Number(message.message_id),
    media.file_id,
    media.media_type,
    null,
    now,
    now,
  );
  const receiptId = Number(result.meta?.last_row_id);
  if (service) {
    await run(env.DB, "UPDATE services SET payment_status='pending', updated_at=? WHERE id=? AND payment_status!='paid'", now, service.id);
  }
  await run(
    env.DB,
    `INSERT INTO payment_events(service_id, receipt_id, action, amount_minor, currency, period_end_before, actor_telegram_id, note, created_at)
     VALUES(?, ?, 'receipt_submitted', ?, 'RUB', ?, ?, ?, ?)`,
    service.id,
    receiptId,
    null,
    service.valid_through,
    userId,
    "Чек из кабинета клиента; сумму проверяет администратор",
    now,
  );
  await clearSession(env.DB, userId);
  const caption = receiptCaption({
    receiptId,
    clientName: service.full_name,
    telegramUsername: service.telegram_username,
    email: service.email,
    siteName: service.site_name,
    siteUrl: service.site_url,
    periodEnd: service.valid_through,
    amountMinor: null,
    note: null,
    lastPayment,
  });
  await enqueueArchiveCopy(env, {
    key: `archive:receipt:${receiptId}:copy`,
    fromChatId: message.chat.id,
    messageId: message.message_id,
    caption,
    serviceId: service.id,
    periodEnd: service.valid_through,
    receiptId,
  });
  const buttons = service
    ? inline([[button("Подтвердить оплату", `receipt:approve:${receiptId}`), button("Отклонить", `receipt:reject:${receiptId}`)], [button("Открыть", `receipt:view:${receiptId}`)]])
    : inline([[button("Привязать к сайту", `receipt:link:${receiptId}`), button("Отклонить", `receipt:reject:${receiptId}`)], [button("Открыть", `receipt:view:${receiptId}`)]]);
  await enqueueAdminsCopy(env, {
    key: `receipt:${receiptId}:admin-copy`,
    fromChatId: message.chat.id,
    messageId: message.message_id,
    caption,
    keyboard: buttons,
    category: "receipt_admin_copy",
    serviceId: service.id,
    periodEnd: service.valid_through,
  });
  await recordEvent(env, {
    actorId: userId,
    action: "receipt_submitted",
    entityType: "receipt",
    entityId: receiptId,
    details: { serviceId: service?.id ?? null },
    archiveText: `Получен чек #${receiptId}. Статус: ожидает ручной проверки. Оплата не подтверждена.\nКлиент: ${service.full_name}\nТелефон: ${service.phone || "не указан"}\nTelegram: ${service.telegram_username || "ник не задан"}\nE-mail: ${service.email || "не указан"}\nСайт: ${service.site_name}\n${lastPayment ? `Последняя подтверждённая оплата: ${String(lastPayment.created_at).slice(0, 10)}${lastPayment.amount_minor == null ? "" : ` · ${formatMoney(lastPayment.amount_minor)}`}` : "Подтверждённых оплат пока нет"}\nДата чека: ${localDateString()}`,
    archiveKey: `archive:receipt:${receiptId}:event`,
  });
  await sendUserText(
    env,
    updateId,
    chatId,
    "Чек передан администратору и ожидает проверки. Отправка чека не означает, что оплата уже подтверждена.",
    null,
    "receipt_ack",
  );
}

function extractMedia(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    const photo = message.photo.at(-1);
    return photo?.file_id ? { file_id: photo.file_id, media_type: "photo" } : null;
  }
  if (message.document?.file_id && (message.document.mime_type === "application/pdf" || message.document.mime_type?.startsWith("image/"))) {
    return { file_id: message.document.file_id, media_type: "document" };
  }
  return null;
}

async function handleAdminCreationStep(env, updateId, message, session) {
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  const text = cleanText(message.text ?? "", 1000);
  const skip = ["-", "—", "нет", "нет данных"].includes(text.toLowerCase());
  const data = session.data || {};

  if (session.flow === "new_client") {
    switch (session.step) {
      case "name":
        if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Введите имя клиента (1–160 символов).", null, "admin_prompt");
        data.full_name = text;
        await saveSession(env.DB, userId, { flow: session.flow, step: "phone", data });
        return sendUserText(env, updateId, chatId, "Введите телефон клиента или `-`, если его пока нет.", null, "admin_prompt");
      case "phone":
        data.phone = skip ? null : text.slice(0, 80);
        await saveSession(env.DB, userId, { flow: session.flow, step: "telegram_username", data });
        return sendUserText(env, updateId, chatId, "Введите Telegram-ник клиента, например @username, или `-`, если его нет.", null, "admin_prompt");
      case "telegram_username": {
        const username = skip ? null : normalizeTelegramUsername(text);
        if (!skip && username === undefined) return sendUserText(env, updateId, chatId, "Введите ник вида @username (5–32 символа) или `-`.", null, "admin_prompt");
        data.telegram_username = username;
        await saveSession(env.DB, userId, { flow: session.flow, step: "email", data });
        return sendUserText(env, updateId, chatId, "Введите e-mail клиента или `-`, если пока неизвестен.", null, "admin_prompt");
      }
      case "email":
        if (!skip && !isValidEmail(text)) return sendUserText(env, updateId, chatId, "Введите корректный e-mail или `-`.", null, "admin_prompt");
        data.email = skip ? null : text.toLowerCase();
        await saveSession(env.DB, userId, { flow: session.flow, step: "site_name", data });
        return sendUserText(env, updateId, chatId, "Введите название первого сайта клиента.", null, "admin_prompt");
      case "site_name":
        if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Введите название сайта (1–160 символов).", null, "admin_prompt");
        data.site_name = text;
        await saveSession(env.DB, userId, { flow: session.flow, step: "site_url", data });
        return sendUserText(env, updateId, chatId, "Введите полный URL сайта, начиная с https:// или http://.", null, "admin_prompt");
      case "site_url":
        if (!isSafeHttpUrl(text)) return sendUserText(env, updateId, chatId, "Нужен корректный URL с https:// или http://.", null, "admin_prompt");
        data.site_url = text;
        await saveSession(env.DB, userId, { flow: session.flow, step: "price", data });
        return sendUserText(env, updateId, chatId, "Введите ежемесячную стоимость в ₽, например 5000.", null, "admin_prompt");
      case "price": {
        const amount = parseMoneyMinor(text);
        if (amount == null) return sendUserText(env, updateId, chatId, "Введите сумму числом, например 5000 или 5000,50.", null, "admin_prompt");
        data.monthly_price_minor = amount;
        await saveSession(env.DB, userId, { flow: session.flow, step: "valid_through", data });
        return sendUserText(env, updateId, chatId, "Введите последний оплаченный день в формате ГГГГ-ММ-ДД.", null, "admin_prompt");
      }
      case "valid_through": {
        if (!isIsoDate(text)) return sendUserText(env, updateId, chatId, "Введите существующую дату в формате ГГГГ-ММ-ДД.", null, "admin_prompt");
        data.valid_through = text;
        const now = nowIso();
        const client = await run(
          env.DB,
          "INSERT INTO clients(full_name, phone, telegram_user_id, telegram_username, email, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
          data.full_name,
          data.phone,
          data.telegram_user_id ?? null,
          data.telegram_username ?? null,
          data.email ?? null,
          now,
          now,
        );
        const clientId = Number(client.meta?.last_row_id);
        const initialPaymentStatus = data.valid_through >= localDateString() ? "paid" : "unpaid";
        const service = await run(
          env.DB,
          `INSERT INTO services(client_id, site_name, site_url, monthly_price_minor, currency, valid_through, payment_status, status, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'RUB', ?, ?, 'active', ?, ?)`,
          clientId,
          data.site_name,
          data.site_url,
          data.monthly_price_minor,
          data.valid_through,
          initialPaymentStatus,
          now,
          now,
        );
        const serviceId = Number(service.meta?.last_row_id);
        await clearSession(env.DB, userId);
        const summary = `Добавлен клиент #${clientId}: ${data.full_name}\nТелефон: ${data.phone || "не указан"}\nTelegram: ${data.telegram_username || "ник не указан"}\nE-mail: ${data.email || "не указан"}\nСайт: ${data.site_name} — ${data.site_url}\nСтоимость: ${formatMoney(data.monthly_price_minor)} в месяц\nОплачено по: ${data.valid_through}`;
        await recordEvent(env, {
          actorId: userId,
          action: "client_and_service_created",
          entityType: "client",
          entityId: clientId,
          details: { clientId, serviceId },
          archiveText: summary,
          archiveKey: `archive:client:${clientId}:created`,
        });
        if (data.telegram_user_id) {
          await enqueueText(env, {
            target: "user",
            chatId: data.telegram_user_id,
            key: `client:${clientId}:activated:${data.telegram_user_id}`,
            text: `Здравствуйте! Добро пожаловать в кабинет K web.\n\n${clientWelcomeText([{ valid_through: data.valid_through, pending_receipts: 0 }])}`,
            keyboard: inline([
              [button("Запросить реквизиты для оплаты", "receipt:start")],
              [button("Проверить подписку", "cabinet")],
            ]),
            category: "client_activated",
          });
          if (session.requestId) {
            await run(env.DB, "UPDATE service_requests SET status='handled', updated_at=? WHERE id=? AND status='new'", now, Number(session.requestId));
          }
        }
        return displayAdminMenu(env, updateId, chatId, `Клиент и первый сайт добавлены.\n${summary}`);
      }
    }
  }

  if (session.flow === "new_service") {
    switch (session.step) {
      case "site_name":
        if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Введите название сайта (1–160 символов).", null, "admin_prompt");
        data.site_name = text;
        await saveSession(env.DB, userId, { ...session, step: "site_url", data });
        return sendUserText(env, updateId, chatId, "Введите полный URL сайта, начиная с https:// или http://.", null, "admin_prompt");
      case "site_url":
        if (!isSafeHttpUrl(text)) return sendUserText(env, updateId, chatId, "Нужен корректный URL с https:// или http://.", null, "admin_prompt");
        data.site_url = text;
        await saveSession(env.DB, userId, { ...session, step: "price", data });
        return sendUserText(env, updateId, chatId, "Введите ежемесячную стоимость в ₽, например 5000.", null, "admin_prompt");
      case "price": {
        const amount = parseMoneyMinor(text);
        if (amount == null) return sendUserText(env, updateId, chatId, "Введите сумму числом.", null, "admin_prompt");
        data.monthly_price_minor = amount;
        await saveSession(env.DB, userId, { ...session, step: "valid_through", data });
        return sendUserText(env, updateId, chatId, "Введите последний оплаченный день в формате ГГГГ-ММ-ДД.", null, "admin_prompt");
      }
      case "valid_through": {
        if (!isIsoDate(text)) return sendUserText(env, updateId, chatId, "Введите существующую дату в формате ГГГГ-ММ-ДД.", null, "admin_prompt");
        const clientId = Number(session.clientId);
        const now = nowIso();
        const initialPaymentStatus = text >= localDateString() ? "paid" : "unpaid";
        const result = await run(
          env.DB,
          `INSERT INTO services(client_id, site_name, site_url, monthly_price_minor, currency, valid_through, payment_status, status, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'RUB', ?, ?, 'active', ?, ?)`,
          clientId,
          data.site_name,
          data.site_url,
          data.monthly_price_minor,
          text,
          initialPaymentStatus,
          now,
          now,
        );
        const serviceId = Number(result.meta?.last_row_id);
        const client = await first(env.DB, "SELECT full_name FROM clients WHERE id=?", clientId);
        await clearSession(env.DB, userId);
        const summary = `Добавлен сайт #${serviceId} для клиента ${client?.full_name || `#${clientId}`}: ${data.site_name} — ${data.site_url}\nСтоимость: ${formatMoney(data.monthly_price_minor)} в месяц\nОплачено по: ${text}`;
        await recordEvent(env, {
          actorId: userId,
          action: "service_created",
          entityType: "service",
          entityId: serviceId,
          details: { clientId, serviceId },
          archiveText: summary,
          archiveKey: `archive:service:${serviceId}:created`,
        });
        return showService(env, updateId, chatId, serviceId, `Сайт добавлен.\n${summary}`);
      }
    }
  }

  return sendUserText(env, updateId, chatId, "Не удалось продолжить форму. Отправьте /cancel и начните заново.", null, "admin_prompt");
}

async function handleEditStep(env, updateId, message, session) {
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  const text = cleanText(message.text ?? "", 800);
  const now = nowIso();
  if (session.flow === "edit_client") {
    const client = await first(env.DB, "SELECT * FROM clients WHERE id=?", Number(session.clientId));
    if (!client) {
      await clearSession(env.DB, userId);
      return sendUserText(env, updateId, chatId, "Клиент не найден.", null, "edit_result");
    }
    let column;
    let value;
    if (session.field === "name") {
      if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Имя должно содержать от 1 до 160 символов.", null, "edit_prompt");
      column = "full_name";
      value = text;
    } else if (session.field === "phone") {
      column = "phone";
      value = ["-", "—"].includes(text) ? null : text.slice(0, 80);
    } else if (session.field === "telegram_username") {
      if (!["-", "—"].includes(text) && normalizeTelegramUsername(text) === undefined) return sendUserText(env, updateId, chatId, "Введите ник вида @username (5–32 символа) или `-`.", null, "edit_prompt");
      column = "telegram_username";
      value = ["-", "—"].includes(text) ? null : normalizeTelegramUsername(text);
    } else if (session.field === "email") {
      if (!["-", "—"].includes(text) && !isValidEmail(text)) return sendUserText(env, updateId, chatId, "Введите корректный e-mail или `-`.", null, "edit_prompt");
      column = "email";
      value = ["-", "—"].includes(text) ? null : text.toLowerCase();
    }
    if (!column) return sendUserText(env, updateId, chatId, "Неизвестное поле.", null, "edit_result");
    await run(env.DB, `UPDATE clients SET ${column}=?, updated_at=? WHERE id=?`, value, now, client.id);
    await clearSession(env.DB, userId);
    const archiveText = `Изменены данные клиента #${client.id} (${client.full_name}). Поле: ${column}.`;
    await recordEvent(env, {
      actorId: userId,
      action: "client_data_updated",
      entityType: "client",
      entityId: client.id,
      details: { field: column },
      archiveText,
      archiveKey: `archive:client:${client.id}:edit:${now}`,
    });
    return showClient(env, updateId, chatId, client.id, "Данные клиента сохранены.");
  }

  if (session.flow === "edit_service") {
    const service = await first(env.DB, "SELECT * FROM services WHERE id=?", Number(session.serviceId));
    if (!service) {
      await clearSession(env.DB, userId);
      return sendUserText(env, updateId, chatId, "Сайт не найден.", null, "edit_result");
    }
    let column;
    let value;
    if (session.field === "name") {
      if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Название должно содержать от 1 до 160 символов.", null, "edit_prompt");
      column = "site_name";
      value = text;
    } else if (session.field === "url") {
      if (!isSafeHttpUrl(text)) return sendUserText(env, updateId, chatId, "Введите полный URL с https:// или http://.", null, "edit_prompt");
      column = "site_url";
      value = text;
    } else if (session.field === "price") {
      value = parseMoneyMinor(text);
      if (value == null) return sendUserText(env, updateId, chatId, "Введите корректную сумму, например 5000.", null, "edit_prompt");
      column = "monthly_price_minor";
    } else if (session.field === "date") {
      if (!isIsoDate(text)) return sendUserText(env, updateId, chatId, "Введите дату в формате ГГГГ-ММ-ДД.", null, "edit_prompt");
      column = "valid_through";
      value = text;
    }
    if (!column) return sendUserText(env, updateId, chatId, "Неизвестное поле.", null, "edit_result");
    await run(
      env.DB,
      `UPDATE services SET ${column}=?, ${column === "valid_through" ? "payment_status='unpaid'," : ""} updated_at=? WHERE id=?`,
      value,
      now,
      service.id,
    );
    if (column === "valid_through") {
      await cancelOldReminders(env.DB, service.id, service.valid_through);
    }
    await clearSession(env.DB, userId);
    const archiveText = `Изменены данные сайта #${service.id} (${service.site_name}). Поле: ${column}; значение изменено администратором.`;
    await recordEvent(env, {
      actorId: userId,
      action: "service_data_updated",
      entityType: "service",
      entityId: service.id,
      details: { field: column },
      archiveText,
      archiveKey: `archive:service:${service.id}:edit:${now}`,
    });
    return showService(env, updateId, chatId, service.id, "Данные сайта сохранены.");
  }
  return sendUserText(env, updateId, chatId, "Не удалось продолжить изменение. Отправьте /cancel и начните заново.", null, "edit_result");
}

async function handleUserSession(env, updateId, message, session) {
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  if (message.chat?.type !== "private") return;
  if (session.flow === "payment_requisites") {
    if (!isAdmin(userId, env)) {
      await clearSession(env.DB, userId);
      return sendUserText(env, updateId, chatId, "Нет доступа.", null, "access_denied");
    }
    const text = cleanText(message.text ?? "", 1800);
    if (!text) return sendUserText(env, updateId, chatId, "Отправьте текст реквизитов или /cancel для отмены.", null, "requisites_prompt");
    await setSetting(env.DB, "payment_requisites", text);
    await clearSession(env.DB, userId);
    await recordEvent(env, {
      actorId: userId,
      action: "payment_requisites_updated",
      entityType: "settings",
      entityId: "payment_requisites",
      details: { valueHidden: true },
      archiveText: "Администратор обновил реквизиты для оплаты. Сами реквизиты не записаны в архив.",
      archiveKey: `archive:payment-requisites-updated:${nowIso()}`,
    });
    return showPaymentRequisites(env, updateId, chatId);
  }
  if (session.flow === "new_client" || session.flow === "new_service") return handleAdminCreationStep(env, updateId, message, session);
  if (session.flow === "edit_client" || session.flow === "edit_service") return handleEditStep(env, updateId, message, session);

  const text = cleanText(message.text ?? "", 2500);
  const data = session.data || {};

  if (session.flow === "request") {
    if (session.step === "name") {
      if (!text || text.length > 160) return sendUserText(env, updateId, chatId, "Введите имя (1–160 символов).", null, "request_prompt");
      data.full_name = text;
      await saveSession(env.DB, userId, { flow: "request", step: "phone", data });
      return askPhone(env, updateId, chatId);
    }
    if (session.step === "phone") {
      const contact = message.contact;
      if (contact && contact.user_id != null && String(contact.user_id) !== userId) {
        return sendUserText(env, updateId, chatId, "Можно отправить только свой номер или ввести его текстом.", null, "request_phone_prompt");
      }
      const phone = cleanText(contact?.phone_number ?? text, 80);
      if (phone.replace(/\D/g, "").length < 6) return sendUserText(env, updateId, chatId, "Введите корректный телефон или поделитесь контактом.", null, "request_phone_prompt");
      data.phone = phone;
      await saveSession(env.DB, userId, { flow: "request", step: "email", data });
      await removeReplyKeyboard(env, updateId, chatId, "Введите e-mail для связи.");
      return;
    }
    if (session.step === "email") {
      if (!isValidEmail(text)) return sendUserText(env, updateId, chatId, "Введите корректный e-mail, например name@example.com.", null, "request_prompt");
      data.email = text.toLowerCase();
      await saveSession(env.DB, userId, { flow: "request", step: "site", data });
      return sendUserText(env, updateId, chatId, "Укажите адрес сайта. Если сайта ещё нет, напишите «пока нет».", null, "request_prompt");
    }
    if (session.step === "site") {
      if (!text || text.length > 500) return sendUserText(env, updateId, chatId, "Введите адрес сайта или «пока нет».", null, "request_prompt");
      data.site_url = text;
      await saveSession(env.DB, userId, { flow: "request", step: "details", data });
      return sendUserText(env, updateId, chatId, "Кратко опишите, что нужно сделать.", null, "request_prompt");
    }
    if (session.step === "details") {
      if (!text || text.length > 2000) return sendUserText(env, updateId, chatId, "Добавьте описание до 2000 символов.", null, "request_prompt");
      data.details = text;
      return finishClientRequest(env, updateId, message, { ...session, data });
    }
  }

  if (session.flow === "receipt") {
    if (session.step === "proof") {
      const media = extractMedia(message);
      if (!media) return sendUserText(env, updateId, chatId, "В этом шаге можно отправить только фотографию или PDF чека — без текстового сообщения.", null, "receipt_prompt");
      return createReceipt(env, updateId, message, session, media);
    }
  }

  return sendUserText(env, updateId, chatId, "Состояние формы устарело. Отправьте /cancel и начните заново.", null, "flow_expired");
}

async function showClients(env, updateId, chatId, page = 1) {
  const size = 8;
  const offset = (page - 1) * size;
  const clients = await all(
    env.DB,
    `SELECT c.id, c.full_name, c.phone,
       (SELECT COUNT(*) FROM services s WHERE s.client_id=c.id AND s.status='active') AS service_count
     FROM clients c WHERE c.status='active' ORDER BY c.full_name COLLATE NOCASE LIMIT ? OFFSET ?`,
    size,
    offset,
  );
  const total = await first(env.DB, "SELECT COUNT(*) AS total FROM clients WHERE status='active'");
  const rows = clients.map((client) => [button(`${client.full_name} · ${client.service_count} сайт(а)`, `client:view:${client.id}`)]);
  const nav = [];
  if (page > 1) nav.push(button("‹", `clients:${page - 1}`));
  if (offset + clients.length < Number(total?.total ?? 0)) nav.push(button("›", `clients:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button("Добавить клиента", "client:add"), button("В меню", "menu:admin")]);
  const text = clients.length
    ? `Клиенты · страница ${page}\nВыберите клиента:`
    : "Активных клиентов пока нет. Добавьте первого клиента.";
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_list");
}

async function showClient(env, updateId, chatId, clientId, prefix = "") {
  const client = await first(env.DB, "SELECT * FROM clients WHERE id=?", Number(clientId));
  if (!client) return sendUserText(env, updateId, chatId, "Клиент не найден.", inline(backToAdmin()), "admin_detail");
  const services = await all(env.DB, "SELECT * FROM services WHERE client_id=? AND status='active' ORDER BY id DESC LIMIT 12", client.id);
  const rows = services.map((service) => [button(`${service.site_name} · до ${service.valid_through}`, `service:view:${service.id}`)]);
  rows.push([button("Добавить сайт", `service:add:${client.id}`), button("Изменить данные", `client:edit:${client.id}`)]);
  rows.push([button("Архивировать клиента", `client:archive:${client.id}`), button("Назад", "clients:1")]);
  const serviceList = services.length ? `\nСайты: ${services.length}` : "\nАктивных сайтов нет.";
  const text = `${prefix ? `${prefix}\n\n` : ""}Клиент #${client.id}: ${client.full_name}\nТелефон: ${client.phone || "не указан"}\nTelegram: ${client.telegram_username || "ник не указан"}\nE-mail: ${client.email || "не указан"}\nКабинет: ${client.telegram_user_id ? "подключён" : "не подключён"}${serviceList}`;
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_detail");
}

async function showServices(env, updateId, chatId, page = 1) {
  const size = 8;
  const offset = (page - 1) * size;
  const services = await all(
    env.DB,
    `SELECT s.id, s.site_name, s.site_url, s.valid_through, s.payment_status, c.full_name
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active'
     ORDER BY s.valid_through ASC, s.id DESC LIMIT ? OFFSET ?`,
    size,
    offset,
  );
  const total = await first(env.DB, "SELECT COUNT(*) AS total FROM services WHERE status='active'");
  const rows = services.map((service) => [button(`${service.site_name} · ${service.full_name} · до ${service.valid_through}`, `service:view:${service.id}`)]);
  const nav = [];
  if (page > 1) nav.push(button("‹", `services:${page - 1}`));
  if (offset + services.length < Number(total?.total ?? 0)) nav.push(button("›", `services:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button("В меню", "menu:admin")]);
  return sendUserText(env, updateId, chatId, services.length ? `Сайты и подписки · ${page}` : "Активных сайтов пока нет.", inline(rows), "admin_list");
}

async function showService(env, updateId, chatId, serviceId, prefix = "") {
  const service = await first(
    env.DB,
    `SELECT s.*, c.full_name, c.phone, c.telegram_user_id
     FROM services s JOIN clients c ON c.id=s.client_id WHERE s.id=?`,
    Number(serviceId),
  );
  if (!service) return sendUserText(env, updateId, chatId, "Сайт не найден.", inline(backToAdmin()), "admin_detail");
  const status = service.status === "archived" ? "архив" : service.payment_status === "paid" ? "оплачено" : service.payment_status === "pending" ? "чек на проверке" : "ожидает оплаты";
  const rows = [
    [button("Изменить данные", `service:edit:${service.id}`), button("История оплат", `history:service:${service.id}`)],
  ];
  if (service.status === "active" && service.payment_status !== "paid") {
    rows.push([button("Подтвердить оплату", `service:manual:${service.id}`)]);
  }
  rows.push([button("Архивировать сайт", `service:archive:${service.id}`), button("Клиент", `client:view:${service.client_id}`)]);
  const text = `${prefix ? `${prefix}\n\n` : ""}Сайт #${service.id}: ${service.site_name}\nКлиент: ${service.full_name}\nURL: ${service.site_url}\nОбслуживание: ${formatMoney(service.monthly_price_minor)} / месяц\nОплачено по: ${service.valid_through}\nСтатус: ${status}`;
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_detail");
}

async function showPayments(env, updateId, chatId) {
  const receipts = await all(
    env.DB,
    `SELECT r.id, r.amount_minor, r.period_end, r.created_at, r.service_id,
       s.site_name, c.full_name
     FROM receipts r LEFT JOIN services s ON s.id=r.service_id
     LEFT JOIN clients c ON c.id=r.client_id
     WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT 10`,
  );
  const rows = receipts.map((receipt) => [button(`Чек #${receipt.id} · ${receipt.full_name || "клиент не найден"} · ${receipt.site_name || "без сайта"}`, `receipt:view:${receipt.id}`)]);
  const unpaid = await all(
    env.DB,
    `SELECT s.id, s.site_name, s.valid_through, c.full_name
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active' AND (s.payment_status!='paid' OR s.valid_through<=?)
     ORDER BY s.valid_through ASC LIMIT 8`,
    localDateString(),
  );
  for (const service of unpaid) rows.push([button(`Продление: ${service.site_name} · ${service.full_name} · до ${service.valid_through}`, `service:view:${service.id}`)]);
  rows.push([button("В меню", "menu:admin")]);
  const text = receipts.length || unpaid.length
    ? `Чеки и оплаты\nНа проверке: ${receipts.length}\nСайтов ожидают оплату: ${unpaid.length}`
    : "Ожидающих чеков или оплат нет.";
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_list");
}

async function showReceipt(env, updateId, chatId, receiptId, prefix = "") {
  const receipt = await first(
    env.DB,
    `SELECT r.*, c.full_name, c.phone, c.telegram_username, c.email, s.site_name, s.site_url, s.valid_through, s.monthly_price_minor
     FROM receipts r LEFT JOIN clients c ON c.id=r.client_id
     LEFT JOIN services s ON s.id=r.service_id WHERE r.id=?`,
    Number(receiptId),
  );
  if (!receipt) return sendUserText(env, updateId, chatId, "Чек не найден.", inline(backToAdmin()), "admin_detail");
  const rows = [];
  if (receipt.status === "pending" && receipt.service_id) {
    rows.push([button("Подтвердить оплату", `receipt:approve:${receipt.id}`), button("Отклонить", `receipt:reject:${receipt.id}`)]);
  } else if (receipt.status === "pending") {
    rows.push([button("Привязать к сайту", `receipt:link:${receipt.id}`), button("Отклонить", `receipt:reject:${receipt.id}`)]);
  }
  rows.push([button("К списку", "payments:1"), button("В меню", "menu:admin")]);
  const text = `${prefix ? `${prefix}\n\n` : ""}Чек #${receipt.id}\nСтатус: ${receipt.status === "pending" ? "ожидает ручной проверки" : receipt.status === "approved" ? "подтверждён" : "отклонён"}\nКлиент: ${receipt.full_name || "не определён"}\nТелефон: ${receipt.phone || "не указан"}\nTelegram: ${receipt.telegram_username || "ник не задан"}\nE-mail: ${receipt.email || "не указан"}\nСайт: ${receipt.site_name || "не привязан"}${receipt.site_url ? ` — ${receipt.site_url}` : ""}\nСумма: ${receipt.amount_minor == null ? "не указана" : formatMoney(receipt.amount_minor)}\nДата получения: ${receipt.created_at}\nОплачено до проверки: ${receipt.period_end || "не определено"}`;
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_detail");
}

async function showReceiptLinkOptions(env, updateId, chatId, receiptId) {
  const receipt = await first(env.DB, "SELECT id, status FROM receipts WHERE id=?", Number(receiptId));
  if (!receipt || receipt.status !== "pending") return showReceipt(env, updateId, chatId, receiptId, "Чек уже обработан или не найден.");
  const services = await all(
    env.DB,
    `SELECT s.id, s.site_name, s.valid_through, c.full_name
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active' ORDER BY c.full_name, s.site_name LIMIT 24`,
  );
  const rows = services.map((service) => [button(`${service.full_name} · ${service.site_name}`, `receipt:linkto:${receiptId}:${service.id}`)]);
  rows.push([button("Назад", `receipt:view:${receiptId}`)]);
  return sendUserText(env, updateId, chatId, "Выберите сайт, к которому относится чек. После привязки можно проверить оплату.", inline(rows), "admin_list");
}

async function showRequests(env, updateId, chatId, page = 1) {
  const size = 8;
  const offset = (page - 1) * size;
  const requests = await all(
    env.DB,
    `SELECT id, full_name, site_url, created_at FROM service_requests WHERE status='new' ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    size,
    offset,
  );
  const total = await first(env.DB, "SELECT COUNT(*) AS total FROM service_requests WHERE status='new'");
  const rows = requests.map((request) => [button(`${request.full_name} · ${request.site_url}`, `request:view:${request.id}`)]);
  const nav = [];
  if (page > 1) nav.push(button("‹", `requests:${page - 1}`));
  if (offset + requests.length < Number(total?.total ?? 0)) nav.push(button("›", `requests:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button("В меню", "menu:admin")]);
  return sendUserText(env, updateId, chatId, requests.length ? `Новые заявки · ${page}` : "Новых заявок нет.", inline(rows), "admin_list");
}

async function showRequest(env, updateId, chatId, requestId) {
  const request = await first(env.DB, "SELECT * FROM service_requests WHERE id=?", Number(requestId));
  if (!request) return sendUserText(env, updateId, chatId, "Заявка не найдена.", inline(backToAdmin()), "admin_detail");
  const rows = [];
  if (request.status === "new") {
    rows.push([button("Создать профиль и открыть доступ", `request:provision:${request.id}`)]);
    rows.push([button("Отметить обработанной", `request:handled:${request.id}`), button("Закрыть", `request:close:${request.id}`)]);
  }
  rows.push([button("К заявкам", "requests:1"), button("В меню", "menu:admin")]);
  const text = `Заявка #${request.id}\nСтатус: ${request.status}\nКлиент: ${request.full_name}\nТелефон: ${request.phone}\nTelegram: ${request.telegram_username || "ник не задан"}\nE-mail: ${request.email || "не указан"}\nСайт: ${request.site_url}\nОписание: ${request.details}\nДата: ${request.created_at}`;
  return sendUserText(env, updateId, chatId, text, inline(rows), "admin_detail");
}

async function provisionRequest(env, updateId, chatId, adminId, requestId) {
  const request = await first(env.DB, "SELECT * FROM service_requests WHERE id=? AND status='new'", Number(requestId));
  if (!request) return showRequest(env, updateId, chatId, requestId, "Заявка уже обработана или не найдена.");
  const username = request.telegram_username ? normalizeTelegramUsername(request.telegram_username) : null;
  const data = {
    full_name: request.full_name,
    phone: request.phone,
    telegram_username: username || null,
    email: request.email || null,
    telegram_user_id: request.telegram_user_id,
  };
  await saveSession(env.DB, adminId, { flow: "new_client", step: "site_name", data, requestId: Number(request.id) });
  return sendUserText(env, updateId, chatId, `Подключение клиента ${request.full_name}. Введите название первого сайта. После заполнения сайта, тарифа и даты кабинет будет привязан к Telegram аккаунту заявки, а клиент получит уведомление.`, null, "admin_prompt");
}

async function showHistory(env, updateId, chatId, serviceId = null) {
  const events = serviceId
    ? await all(env.DB, "SELECT * FROM payment_events WHERE service_id=? ORDER BY id DESC LIMIT 20", Number(serviceId))
    : await all(env.DB, "SELECT * FROM audit_events ORDER BY id DESC LIMIT 20");
  const lines = events.map((event) => {
    const date = event.created_at || "";
    const action = event.action || "event";
    const entity = event.entity_type ? ` ${event.entity_type} #${event.entity_id || ""}` : "";
    const amount = event.amount_minor == null ? "" : ` · ${formatMoney(event.amount_minor, event.currency || "RUB")}`;
    const beforeAfter = event.period_end_after ? ` · до ${event.period_end_after}` : "";
    return `• ${date} — ${action}${entity}${amount}${beforeAfter}`;
  });
  const text = lines.length ? `История${serviceId ? ` сайта #${serviceId}` : " работы"}\n${lines.join("\n")}` : "История пока пуста.";
  return sendUserText(env, updateId, chatId, text.slice(0, MAX_MESSAGE), inline([[button("В меню", "menu:admin")]]), "admin_history");
}

async function showBackup(env, updateId, chatId, adminId) {
  const tableNames = ["clients", "services", "service_requests", "receipts", "payment_events", "audit_events", "reminder_sends"];
  const backup = { schemaVersion: 1, createdAt: nowIso(), timezone: env.APP_TIME_ZONE || "Europe/Moscow", tables: {} };
  for (const table of tableNames) {
    backup.tables[table] = await all(env.DB, `SELECT * FROM ${table} ORDER BY 1 LIMIT 10000`);
  }
  const services = await all(
    env.DB,
    `SELECT c.full_name, c.phone, c.telegram_username, c.email, s.site_name, s.site_url,
       s.monthly_price_minor, s.currency, s.valid_through, s.payment_status, s.status
     FROM services s JOIN clients c ON c.id=s.client_id ORDER BY c.full_name, s.site_name LIMIT 10000`,
  );
  const csvHeaders = ["full_name", "phone", "telegram_username", "email", "site_name", "site_url", "monthly_price_minor", "currency", "valid_through", "payment_status", "status"];
  const csv = toCsv(services, csvHeaders);
  const date = localDateString();
  try {
    await telegramSendDocument(env, chatId, `kweb-backup-${date}.json`, JSON.stringify(backup, null, 2));
    await telegramSendDocument(env, chatId, `kweb-clients-${date}.csv`, csv, "text/csv; charset=utf-8");
    const event = await recordEvent(env, {
      actorId: adminId,
      action: "backup_exported",
      entityType: "backup",
      details: { tableCount: tableNames.length },
      archiveText: `Администратор запросил резервную копию и CSV. Дата: ${date}.`,
      archiveKey: `archive:backup:${adminId}:${date}:${crypto.randomUUID()}`,
    });
    await enqueueText(env, {
      target: "user",
      chatId,
      key: `backup-complete:${updateId}`,
      text: "Готово: отправлены JSON-резервная копия и CSV. Скачайте их на компьютер в закрытую папку «Работа», например «Работа/Архив сайта/».",
      category: "backup_ack",
    });
    return event;
  } catch {
    await enqueueText(env, {
      target: "user",
      chatId,
      key: `backup-error:${updateId}`,
      text: "Не удалось отправить резервную копию. Проверьте, что личный чат с ботом открыт, и повторите /backup.",
      category: "backup_error",
    });
  }
}

async function exportCsv(env, updateId, chatId, adminId) {
  const rows = await all(
    env.DB,
    `SELECT c.full_name, c.phone, c.telegram_username, c.email, c.status AS client_status,
       s.site_name, s.site_url, s.monthly_price_minor, s.currency, s.valid_through,
       s.payment_status, s.status AS service_status
     FROM clients c LEFT JOIN services s ON s.client_id=c.id
     ORDER BY c.full_name, s.site_name LIMIT 10000`,
  );
  const headers = ["full_name", "phone", "telegram_username", "email", "client_status", "site_name", "site_url", "monthly_price_minor", "currency", "valid_through", "payment_status", "service_status"];
  const csv = toCsv(rows, headers);
  try {
    await telegramSendDocument(env, chatId, `kweb-clients-${localDateString()}.csv`, csv, "text/csv; charset=utf-8");
    const event = await recordEvent(env, {
      actorId: adminId,
      action: "clients_csv_exported",
      entityType: "clients",
      details: { rows: rows.length },
      archiveText: `Администратор выгрузил список клиентов в CSV. Строк: ${rows.length}. Дата: ${localDateString()}.`,
      archiveKey: `archive:csv:${adminId}:${updateId}`,
    });
    return event;
  } catch {
    await sendUserText(env, updateId, chatId, "Не удалось отправить CSV. Проверьте личный чат с ботом и повторите.", null, "csv_error");
  }
}

async function cancelOldReminders(db, serviceId, oldPeriodEnd) {
  const now = nowIso();
  await run(
    db,
    `UPDATE outbox SET status='cancelled', locked_until=NULL, payload_json='{}'
     WHERE category='reminder' AND service_id=? AND period_end=? AND status='pending'`,
    Number(serviceId),
    oldPeriodEnd,
  );
  await run(
    db,
    `UPDATE reminder_sends SET status='cancelled'
     WHERE service_id=? AND period_end=? AND status='queued'`,
    Number(serviceId),
    oldPeriodEnd,
  );
}

async function approveReceipt(env, updateId, chatId, adminId, receiptId) {
  const receipt = await first(env.DB, "SELECT * FROM receipts WHERE id=?", Number(receiptId));
  if (!receipt) return sendUserText(env, updateId, chatId, "Чек не найден.", inline(backToAdmin()), "receipt_result");
  if (receipt.status !== "pending") return showReceipt(env, updateId, chatId, receipt.id, "Этот чек уже обработан.");
  if (!receipt.service_id) return showReceiptLinkOptions(env, updateId, chatId, receipt.id);
  const service = await first(env.DB, "SELECT * FROM services WHERE id=? AND status='active'", receipt.service_id);
  if (!service) return sendUserText(env, updateId, chatId, "Сайт архивирован или не найден. Привяжите чек к действующему сайту.", inline([[button("Привязать к сайту", `receipt:link:${receipt.id}`)]]), "receipt_result");
  if (receipt.period_end && receipt.period_end !== service.valid_through) {
    return showReceipt(env, updateId, chatId, receipt.id, `Дата окончания уже изменилась с ${receipt.period_end} на ${service.valid_through}. Проверьте этот чек вручную; дата не будет продлена автоматически.`);
  }
  const today = localDateString(new Date(), env.APP_TIME_ZONE || "Europe/Moscow");
  const nextDate = renewalDate(service.valid_through, today);
  const now = nowIso();
  const amount = receipt.amount_minor ?? service.monthly_price_minor;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE services SET valid_through=?, payment_status='paid', updated_at=?
      WHERE id=? AND valid_through=? AND status='active'
        AND EXISTS (SELECT 1 FROM receipts WHERE id=? AND status='pending')`)
      .bind(nextDate, now, service.id, service.valid_through, receipt.id),
    env.DB.prepare("UPDATE receipts SET status='approved', updated_at=? WHERE id=? AND status='pending' AND changes()=1")
      .bind(now, receipt.id),
    env.DB.prepare(`INSERT INTO payment_events(service_id, receipt_id, action, amount_minor, currency,
      period_end_before, period_end_after, actor_telegram_id, note, created_at)
      SELECT ?, ?, 'approved', ?, ?, ?, ?, ?, 'Подтверждено администратором после проверки поступления денег', ?
      WHERE changes()=1`)
      .bind(service.id, receipt.id, amount, service.currency, service.valid_through, nextDate, String(adminId), now),
    env.DB.prepare(`UPDATE outbox SET status='cancelled'
      WHERE category='reminder' AND service_id=? AND period_end=? AND status='pending'
        AND EXISTS (SELECT 1 FROM payment_events WHERE receipt_id=? AND action='approved')`)
      .bind(service.id, service.valid_through, receipt.id),
    env.DB.prepare(`UPDATE reminder_sends SET status='cancelled'
      WHERE service_id=? AND period_end=? AND status='queued'
        AND EXISTS (SELECT 1 FROM payment_events WHERE receipt_id=? AND action='approved')`)
      .bind(service.id, service.valid_through, receipt.id),
  ]);
  if (!results[0]?.meta?.changes || !results[1]?.meta?.changes) return showReceipt(env, updateId, chatId, receipt.id, "Период уже был изменён другим действием. Обновите карточку и проверьте оплату.");
  const client = await first(env.DB, "SELECT * FROM clients WHERE id=?", service.client_id);
  const text = `Здравствуйте! Оплата подтверждена.\n\n${clientWelcomeText([{ valid_through: nextDate, pending_receipts: 0 }])}`;
  await recordEvent(env, {
    actorId: adminId,
    action: "payment_approved",
    entityType: "receipt",
    entityId: receipt.id,
    details: { serviceId: service.id, oldEnd: service.valid_through, newEnd: nextDate, amountMinor: amount },
    archiveText: `${text}\nКлиент: ${client?.full_name || "не указан"}\nТелефон: ${client?.phone || "не указан"}\nTelegram: ${client?.telegram_username || "ник не задан"}\nE-mail: ${client?.email || "не указан"}\nДата подтверждения: ${localDateString()}`,
    archiveKey: `archive:receipt:${receipt.id}:approved`,
  });
  if (client?.telegram_user_id) {
    await enqueueText(env, {
      target: "user",
      chatId: client.telegram_user_id,
      key: `receipt:${receipt.id}:approved:user`,
      text,
      keyboard: inline([[button("Проверить подписку", "cabinet")], [button("Запросить реквизиты", "receipt:start")]]),
      category: "payment_result",
      serviceId: service.id,
      periodEnd: nextDate,
    });
  }
  await enqueueText(env, {
    target: "user",
    chatId,
    key: `update:${updateId}:receipt-approved:${receipt.id}`,
    text: `Оплата подтверждена. Период продлён до ${nextDate}.`,
    keyboard: inline(backToAdmin()),
    category: "receipt_result",
  });
}

async function rejectReceipt(env, updateId, chatId, adminId, receiptId) {
  const receipt = await first(env.DB, "SELECT * FROM receipts WHERE id=?", Number(receiptId));
  if (!receipt) return sendUserText(env, updateId, chatId, "Чек не найден.", inline(backToAdmin()), "receipt_result");
  if (receipt.status !== "pending") return showReceipt(env, updateId, chatId, receipt.id, "Этот чек уже обработан.");
  const now = nowIso();
  const result = await run(env.DB, "UPDATE receipts SET status='rejected', updated_at=? WHERE id=? AND status='pending'", now, receipt.id);
  if (!result.meta?.changes) return showReceipt(env, updateId, chatId, receipt.id, "Чек уже обработан.");
  await run(
    env.DB,
    `INSERT INTO payment_events(service_id, receipt_id, action, amount_minor, currency, period_end_before, actor_telegram_id, note, created_at)
     VALUES(?, ?, 'rejected', ?, ?, ?, ?, 'Не подтверждено после проверки администратором', ?)`,
    receipt.service_id,
    receipt.id,
    receipt.amount_minor,
    receipt.currency,
    receipt.period_end,
    String(adminId),
    now,
  );
  if (receipt.service_id) {
    const pending = await first(env.DB, "SELECT COUNT(*) AS count FROM receipts WHERE service_id=? AND status='pending'", receipt.service_id);
    if (!Number(pending?.count)) await run(env.DB, "UPDATE services SET payment_status='unpaid', updated_at=? WHERE id=? AND payment_status='pending'", now, receipt.service_id);
  }
  const client = receipt.client_id ? await first(env.DB, "SELECT * FROM clients WHERE id=?", receipt.client_id) : null;
  const text = "Здравствуйте! Чек проверен, но оплата не подтверждена. Проверьте реквизиты и отправьте подтверждение ещё раз либо свяжитесь с администратором.";
  await recordEvent(env, {
    actorId: adminId,
    action: "payment_rejected",
    entityType: "receipt",
    entityId: receipt.id,
    details: { serviceId: receipt.service_id },
    archiveText: `${text}\nТелефон: ${client?.phone || "не указан"}\nTelegram: ${client?.telegram_username || "ник не задан"}\nE-mail: ${client?.email || "не указан"}\nДата проверки: ${localDateString()}`,
    archiveKey: `archive:receipt:${receipt.id}:rejected`,
  });
  await enqueueText(env, {
    target: "user",
    chatId: receipt.telegram_user_id,
    key: `receipt:${receipt.id}:rejected:user`,
    text: "Чек проверен, но оплата не подтверждена. Свяжитесь с администратором, если считаете это ошибкой.",
    keyboard: inline([[button("Запросить реквизиты", "receipt:start")], [button("Проверить подписку", "cabinet")]]),
    category: "payment_result",
  });
  await sendUserText(env, updateId, chatId, "Чек отклонён; подписка не продлена.", inline(backToAdmin()), "receipt_result");
}

async function manualPayment(env, updateId, chatId, adminId, serviceId) {
  const service = await first(
    env.DB,
    `SELECT s.*, c.full_name, c.telegram_user_id, c.telegram_username, c.email, c.phone FROM services s JOIN clients c ON c.id=s.client_id WHERE s.id=?`,
    Number(serviceId),
  );
  if (!service || service.status !== "active") return sendUserText(env, updateId, chatId, "Активный сайт не найден.", inline(backToAdmin()), "payment_result");
  if (service.payment_status === "paid") return showService(env, updateId, chatId, service.id, "Сайт уже отмечен как оплаченный. Повторное продление не выполнено.");
  const today = localDateString(new Date(), env.APP_TIME_ZONE || "Europe/Moscow");
  const nextDate = renewalDate(service.valid_through, today);
  const now = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE services SET valid_through=?, payment_status='paid', updated_at=?
      WHERE id=? AND valid_through=? AND payment_status!='paid' AND status='active'`)
      .bind(nextDate, now, service.id, service.valid_through),
    env.DB.prepare(`INSERT INTO payment_events(service_id, action, amount_minor, currency, period_end_before,
      period_end_after, actor_telegram_id, note, created_at)
      SELECT ?, 'manual_approved', ?, ?, ?, ?, ?, 'Подтверждено администратором после проверки поступления денег', ?
      WHERE changes()=1`)
      .bind(service.id, service.monthly_price_minor, service.currency, service.valid_through, nextDate, String(adminId), now),
    env.DB.prepare(`UPDATE outbox SET status='cancelled'
      WHERE category='reminder' AND service_id=? AND period_end=? AND status='pending'
        AND EXISTS (SELECT 1 FROM payment_events WHERE service_id=? AND action='manual_approved' AND period_end_after=?)`)
      .bind(service.id, service.valid_through, service.id, nextDate),
    env.DB.prepare(`UPDATE reminder_sends SET status='cancelled'
      WHERE service_id=? AND period_end=? AND status='queued'
        AND EXISTS (SELECT 1 FROM payment_events WHERE service_id=? AND action='manual_approved' AND period_end_after=?)`)
      .bind(service.id, service.valid_through, service.id, nextDate),
  ]);
  if (!results[0]?.meta?.changes) return showService(env, updateId, chatId, service.id, "Сайт изменился во время подтверждения. Обновите карточку и повторите проверку.");
  const text = `Здравствуйте! Оплата подтверждена.\n\n${clientWelcomeText([{ valid_through: nextDate, pending_receipts: 0 }])}`;
  await recordEvent(env, {
    actorId: adminId,
    action: "manual_payment_approved",
    entityType: "service",
    entityId: service.id,
    details: { oldEnd: service.valid_through, newEnd: nextDate, amountMinor: service.monthly_price_minor },
    archiveText: `${text}\nКлиент: ${service.full_name}\nТелефон: ${service.phone || "не указан"}\nTelegram: ${service.telegram_username || "ник не задан"}\nE-mail: ${service.email || "не указан"}\nДата подтверждения: ${localDateString()}`,
    archiveKey: `archive:service:${service.id}:manual-payment:${now}`,
  });
  if (service.telegram_user_id) {
    await enqueueText(env, {
      target: "user",
      chatId: service.telegram_user_id,
      key: `service:${service.id}:manual-payment:${nextDate}:user`,
      text,
      keyboard: inline([[button("Проверить подписку", "cabinet")], [button("Запросить реквизиты", "receipt:start")]]),
      category: "payment_result",
      serviceId: service.id,
      periodEnd: nextDate,
    });
  }
  return showService(env, updateId, chatId, service.id, "Оплата подтверждена, сайт продлён на месяц.");
}

async function linkReceipt(env, updateId, chatId, adminId, receiptId, serviceId) {
  const receipt = await first(env.DB, "SELECT * FROM receipts WHERE id=? AND status='pending'", Number(receiptId));
  const service = await first(env.DB, "SELECT * FROM services WHERE id=? AND status='active'", Number(serviceId));
  if (!receipt || !service) return sendUserText(env, updateId, chatId, "Чек или активный сайт не найден.", inline(backToAdmin()), "receipt_result");
  const now = nowIso();
  await run(
    env.DB,
    "UPDATE receipts SET client_id=?, service_id=?, period_end=?, updated_at=? WHERE id=? AND status='pending'",
    service.client_id,
    service.id,
    service.valid_through,
    now,
    receipt.id,
  );
  await run(env.DB, "UPDATE services SET payment_status='pending', updated_at=? WHERE id=? AND payment_status!='paid'", now, service.id);
  await run(
    env.DB,
    `INSERT INTO payment_events(service_id, receipt_id, action, amount_minor, currency, period_end_before, actor_telegram_id, note, created_at)
     VALUES(?, ?, 'receipt_submitted', ?, ?, ?, ?, 'Чек вручную привязан администратором', ?)`,
    service.id,
    receipt.id,
    receipt.amount_minor,
    receipt.currency,
    service.valid_through,
    String(adminId),
    now,
  );
  await recordEvent(env, {
    actorId: adminId,
    action: "receipt_linked_to_service",
    entityType: "receipt",
    entityId: receipt.id,
    details: { serviceId: service.id },
    archiveText: `Чек #${receipt.id} привязан к сайту ${service.site_name} клиента #${service.client_id}. Подтверждения оплаты ещё нет.`,
    archiveKey: `archive:receipt:${receipt.id}:linked:${service.id}`,
  });
  return showReceipt(env, updateId, chatId, receipt.id, "Чек привязан. Подтвердите оплату только после проверки поступления денег.");
}

async function archiveClient(env, updateId, chatId, adminId, clientId, confirm = false) {
  const client = await first(env.DB, "SELECT * FROM clients WHERE id=?", Number(clientId));
  if (!client) return sendUserText(env, updateId, chatId, "Клиент не найден.", inline(backToAdmin()), "client_result");
  if (!confirm) {
    return sendUserText(
      env,
      updateId,
      chatId,
      `Архивировать клиента ${client.full_name} и его активные сайты? История и платежи сохранятся.`,
      inline([[button("Да, архивировать", `client:archiveyes:${client.id}`), button("Отмена", `client:view:${client.id}`)]]),
      "confirm",
    );
  }
  const now = nowIso();
  await run(env.DB, "UPDATE clients SET status='archived', updated_at=? WHERE id=?", now, client.id);
  await run(env.DB, "UPDATE services SET status='archived', updated_at=? WHERE client_id=? AND status='active'", now, client.id);
  await recordEvent(env, {
    actorId: adminId,
    action: "client_archived",
    entityType: "client",
    entityId: client.id,
    details: { clientId: client.id },
    archiveText: `Клиент архивирован: #${client.id} ${client.full_name}. Связанные активные сайты также архивированы; история сохранена.`,
    archiveKey: `archive:client:${client.id}:archived`,
  });
  return showClient(env, updateId, chatId, client.id, "Клиент архивирован; данные и история сохранены.");
}

async function archiveService(env, updateId, chatId, adminId, serviceId, confirm = false) {
  const service = await first(env.DB, "SELECT * FROM services WHERE id=?", Number(serviceId));
  if (!service) return sendUserText(env, updateId, chatId, "Сайт не найден.", inline(backToAdmin()), "service_result");
  if (!confirm) {
    return sendUserText(env, updateId, chatId, `Архивировать сайт ${service.site_name}? История и чеки сохранятся.`, inline([[button("Да, архивировать", `service:archiveyes:${service.id}`), button("Отмена", `service:view:${service.id}`)]]), "confirm");
  }
  const now = nowIso();
  await run(env.DB, "UPDATE services SET status='archived', updated_at=? WHERE id=?", now, service.id);
  await cancelOldReminders(env.DB, service.id, service.valid_through);
  await recordEvent(env, {
    actorId: adminId,
    action: "service_archived",
    entityType: "service",
    entityId: service.id,
    details: { serviceId: service.id },
    archiveText: `Сайт архивирован: #${service.id} ${service.site_name} (${service.site_url}).`,
    archiveKey: `archive:service:${service.id}:archived`,
  });
  return showService(env, updateId, chatId, service.id, "Сайт архивирован; история и чеки сохранены.");
}

async function markRequest(env, updateId, chatId, adminId, requestId, status) {
  const request = await first(env.DB, "SELECT * FROM service_requests WHERE id=?", Number(requestId));
  if (!request) return sendUserText(env, updateId, chatId, "Заявка не найдена.", inline(backToAdmin()), "request_result");
  if (!["handled", "closed"].includes(status)) return showRequest(env, updateId, chatId, request.id);
  const now = nowIso();
  const changed = await run(env.DB, "UPDATE service_requests SET status=?, updated_at=? WHERE id=? AND status='new'", status, now, request.id);
  if (changed.meta?.changes) {
    const label = status === "handled" ? "обработана" : "закрыта";
    await recordEvent(env, {
      actorId: adminId,
      action: `request_${status}`,
      entityType: "service_request",
      entityId: request.id,
      details: { requestId: request.id, status },
      archiveText: `Заявка #${request.id} от ${request.full_name} ${label}. Сайт: ${request.site_url}.`,
      archiveKey: `archive:request:${request.id}:${status}`,
    });
  }
  return showRequest(env, updateId, chatId, request.id);
}

async function startEditClient(env, updateId, chatId, userId, clientId) {
  const client = await first(env.DB, "SELECT * FROM clients WHERE id=?", Number(clientId));
  if (!client) return sendUserText(env, updateId, chatId, "Клиент не найден.", null, "edit_prompt");
  const rows = [
    [button("Имя", `client:editfield:${client.id}:name`), button("Телефон", `client:editfield:${client.id}:phone`)],
    [button("Telegram-ник", `client:editfield:${client.id}:telegram_username`), button("E-mail", `client:editfield:${client.id}:email`)],
    [button("Назад", `client:view:${client.id}`)],
  ];
  return sendUserText(env, updateId, chatId, `Какие данные клиента ${client.full_name} изменить?`, inline(rows), "edit_menu");
}

async function startEditService(env, updateId, chatId, userId, serviceId) {
  const service = await first(env.DB, "SELECT * FROM services WHERE id=?", Number(serviceId));
  if (!service) return sendUserText(env, updateId, chatId, "Сайт не найден.", null, "edit_prompt");
  const rows = [
    [button("Название", `service:editfield:${service.id}:name`), button("URL", `service:editfield:${service.id}:url`)],
    [button("Стоимость", `service:editfield:${service.id}:price`), button("Дата окончания", `service:editfield:${service.id}:date`)],
    [button("Назад", `service:view:${service.id}`)],
  ];
  return sendUserText(env, updateId, chatId, `Какие данные сайта ${service.site_name} изменить? Изменение даты вручную сбросит статус оплаты и запишется в журнал.`, inline(rows), "edit_menu");
}

async function startEditField(env, updateId, chatId, userId, type, id, field) {
  const prompts = {
    client: { name: "Введите новое имя клиента.", phone: "Введите новый телефон или `-`, чтобы очистить.", telegram_username: "Введите новый Telegram-ник, например @username, или `-`, чтобы очистить.", email: "Введите новый e-mail или `-`, чтобы очистить." },
    service: { name: "Введите новое название сайта.", url: "Введите полный URL сайта с https:// или http://.", price: "Введите новую ежемесячную стоимость в ₽.", date: "Введите последний оплаченный день в формате ГГГГ-ММ-ДД." },
  };
  if (!prompts[type]?.[field]) return sendUserText(env, updateId, chatId, "Неизвестное поле.", null, "edit_prompt");
  const session = type === "client"
    ? { flow: "edit_client", clientId: Number(id), field, data: {} }
    : { flow: "edit_service", serviceId: Number(id), field, data: {} };
  await saveSession(env.DB, userId, session);
  return sendUserText(env, updateId, chatId, prompts[type][field], null, "edit_prompt");
}

async function handleCallback(env, updateId, callback) {
  const callbackId = callback.id;
  const userId = String(callback.from?.id ?? "");
  const chatId = callback.message?.chat?.id == null ? null : String(callback.message.chat.id);
  const data = cleanText(callback.data ?? "", 100);
  try {
    await telegramApi(env, "answerCallbackQuery", { callback_query_id: callbackId });
  } catch {
    // A stale callback query should not block the authorized action.
  }
  if (!chatId || callback.message?.chat?.type !== "private") return;
  const customerAction = data === "request:start" || data === "receipt:start" || data === "receipt:upload" || data === "cabinet" || /^receipt:service:\d+$/.test(data);
  const adminOnly = !customerAction && /^(admin:|clients:|services:|payments:|requests:|history|backup|export:|client:|service:|receipt:|request:)/.test(data);
  if (adminOnly && !isAdmin(userId, env)) {
    return sendUserText(env, updateId, chatId, "У этой кнопки нет доступа. Откройте клиентское меню.", USER_MENU, "access_denied");
  }

  if (data === "menu:admin" && isAdmin(userId, env)) return displayAdminMenu(env, updateId, chatId);
  if (data === "menu:user") return displayUserMenu(env, updateId, chatId);
  if (data === "request:start") return startClientRequest(env, updateId, chatId, userId);
  if (data === "receipt:start") return startReceiptFlow(env, updateId, chatId, userId);
  if (data === "receipt:upload") return startReceiptUpload(env, updateId, chatId, userId);
  if (data === "cabinet") return showClientCabinet(env, updateId, chatId, userId);
  if (/^receipt:service:\d+$/.test(data)) return startReceiptForService(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data === "admin:preview") return showClientPreviewList(env, updateId, chatId);
  if (/^admin:preview:client:\d+$/.test(data)) return showClientPreview(env, updateId, chatId, Number(data.split(":")[3]));
  if (/^admin:preview:req:\d+$/.test(data)) return showPreviewRequisites(env, updateId, chatId, Number(data.split(":")[3]));
  if (/^admin:preview:reqservice:\d+:\d+$/.test(data)) {
    const [, , , clientId, serviceId] = data.split(":");
    return showPreviewServiceRequisites(env, updateId, chatId, Number(clientId), Number(serviceId));
  }
  if (data === "admin:preview:upload") return showPreviewUpload(env, updateId, chatId);
  if (data === "admin:requisites") return showPaymentRequisites(env, updateId, chatId);
  if (data === "admin:requisites:edit") {
    await saveSession(env.DB, userId, { flow: "payment_requisites", step: "value", data: {} });
    return sendUserText(env, updateId, chatId, "Отправьте реквизиты одним сообщением (до 1800 символов). Можно указать получателя, банк, номер счёта/карты и назначение платежа. Не добавляйте сюда пароли или коды доступа.", null, "requisites_prompt");
  }
  if (data === "admin:requisites:clear") return sendUserText(env, updateId, chatId, "Очистить сохранённые реквизиты? Клиенты не смогут запросить их, пока вы не добавите новые.", inline([
    [button("Да, очистить", "admin:requisites:clearyes"), button("Отмена", "admin:requisites")],
  ]), "requisites_clear_confirm");
  if (data === "admin:requisites:clearyes") {
    await setSetting(env.DB, "payment_requisites", "");
    await recordEvent(env, {
      actorId: userId,
      action: "payment_requisites_cleared",
      entityType: "settings",
      entityId: "payment_requisites",
      details: { valueHidden: true },
      archiveText: "Администратор очистил платёжные реквизиты.",
      archiveKey: `archive:payment-requisites-cleared:${nowIso()}`,
    });
    return showPaymentRequisites(env, updateId, chatId);
  }
  if (/^clients:\d+$/.test(data)) return showClients(env, updateId, chatId, Number(data.split(":")[1]));
  if (/^services:\d+$/.test(data)) return showServices(env, updateId, chatId, Number(data.split(":")[1]));
  if (/^requests:\d+$/.test(data)) return showRequests(env, updateId, chatId, Number(data.split(":")[1]));
  if (data === "payments:1") return showPayments(env, updateId, chatId);
  if (data === "history") return showHistory(env, updateId, chatId);
  if (data === "backup") return showBackup(env, updateId, chatId, userId);
  if (data === "export:csv") return exportCsv(env, updateId, chatId, userId);
  if (data === "client:add") {
    await saveSession(env.DB, userId, { flow: "new_client", step: "name", data: {} });
    return sendUserText(env, updateId, chatId, "Добавление клиента. Введите имя.", null, "admin_prompt");
  }
  if (data.startsWith("client:view:")) return showClient(env, updateId, chatId, Number(data.split(":")[2]));
  if (data.startsWith("client:edit:")) return startEditClient(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("client:editfield:")) {
    const [, , id, field] = data.split(":");
    return startEditField(env, updateId, chatId, userId, "client", Number(id), field);
  }
  if (data.startsWith("client:archiveyes:")) return archiveClient(env, updateId, chatId, userId, Number(data.split(":")[2]), true);
  if (data.startsWith("client:archive:")) return archiveClient(env, updateId, chatId, userId, Number(data.split(":")[2]), false);
  if (data.startsWith("service:add:")) {
    const clientId = Number(data.split(":")[2]);
    const client = await first(env.DB, "SELECT id FROM clients WHERE id=? AND status='active'", clientId);
    if (!client) return sendUserText(env, updateId, chatId, "Клиент не найден или архивирован.", inline(backToAdmin()), "admin_result");
    await saveSession(env.DB, userId, { flow: "new_service", step: "site_name", clientId, data: {} });
    return sendUserText(env, updateId, chatId, "Добавление сайта. Введите название.", null, "admin_prompt");
  }
  if (data.startsWith("service:view:")) return showService(env, updateId, chatId, Number(data.split(":")[2]));
  if (data.startsWith("service:edit:")) return startEditService(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("service:editfield:")) {
    const [, , id, field] = data.split(":");
    return startEditField(env, updateId, chatId, userId, "service", Number(id), field);
  }
  if (data.startsWith("service:manualyes:")) return manualPayment(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("service:manual:")) {
    const serviceId = Number(data.split(":")[2]);
    const service = await first(env.DB, "SELECT * FROM services WHERE id=? AND status='active'", serviceId);
    if (!service) return sendUserText(env, updateId, chatId, "Активный сайт не найден.", inline(backToAdmin()), "payment_result");
    if (service.payment_status === "paid") return showService(env, updateId, chatId, service.id, "Статус уже оплачен; повторное продление недоступно.");
    return sendUserText(
      env,
      updateId,
      chatId,
      `Подтвердить поступление ${formatMoney(service.monthly_price_minor, service.currency)} за сайт ${service.site_name}? Подтверждение сразу продлит срок; нажимайте только после фактической проверки оплаты.`,
      inline([[button("Да, деньги поступили", `service:manualyes:${service.id}`), button("Отмена", `service:view:${service.id}`)]]),
      "payment_confirm",
    );
  }
  if (data.startsWith("service:archiveyes:")) return archiveService(env, updateId, chatId, userId, Number(data.split(":")[2]), true);
  if (data.startsWith("service:archive:")) return archiveService(env, updateId, chatId, userId, Number(data.split(":")[2]), false);
  if (data.startsWith("receipt:approve:")) return approveReceipt(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("receipt:reject:")) return rejectReceipt(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("receipt:view:")) return showReceipt(env, updateId, chatId, Number(data.split(":")[2]));
  if (data.startsWith("receipt:link:")) return showReceiptLinkOptions(env, updateId, chatId, Number(data.split(":")[2]));
  if (data.startsWith("receipt:linkto:")) {
    const [, , receiptId, serviceId] = data.split(":");
    return linkReceipt(env, updateId, chatId, userId, Number(receiptId), Number(serviceId));
  }
  if (data.startsWith("request:view:")) return showRequest(env, updateId, chatId, Number(data.split(":")[2]));
  if (data.startsWith("request:provision:")) return provisionRequest(env, updateId, chatId, userId, Number(data.split(":")[2]));
  if (data.startsWith("request:handled:")) return markRequest(env, updateId, chatId, userId, Number(data.split(":")[2]), "handled");
  if (data.startsWith("request:close:")) return markRequest(env, updateId, chatId, userId, Number(data.split(":")[2]), "closed");
  return sendUserText(env, updateId, chatId, "Кнопка устарела. Откройте меню заново.", isAdmin(userId, env) ? ADMIN_MENU : USER_MENU, "stale_button");
}

async function handleGroupMessage(env, updateId, message) {
  const userId = String(message.from?.id ?? "");
  const chatId = String(message.chat?.id ?? "");
  const text = cleanText(message.text ?? "", 100);
  if (!isAdmin(userId, env) || !/^\/setarchive(?:@\w+)?(?:\s|$)/i.test(text)) return;
  await setSetting(env.DB, "archive_chat_id", chatId);
  const now = nowIso();
  const event = await recordEvent(env, {
    actorId: userId,
    action: "archive_group_configured",
    entityType: "settings",
    entityId: "archive_chat_id",
    details: { groupConfigured: true },
    archiveText: `Подключена закрытая архивная группа Telegram. Дата: ${now}.`,
    archiveKey: `archive:group-configured:${chatId}`,
  });
  await enqueueText(env, {
    target: "archive",
    key: `archive:group-test:${chatId}`,
    text: "Архив K web подключён. Здесь будут заявки, копии чеков и важные события.",
    category: "archive_test",
  });
  await enqueueText(env, {
    target: "user",
    chatId,
    key: `update:${updateId}:archive-confirm:${chatId}`,
    text: "Закрытая группа подключена как архив K web. Проверьте, что в ней есть только нужные участники.",
    category: "archive_confirm",
  });
  return event;
}

async function handleMessage(env, updateId, message) {
  if (!message?.from || !message?.chat) return;
  if (isGroupChat(message.chat)) return handleGroupMessage(env, updateId, message);
  if (message.chat.type !== "private") return;
  const userId = String(message.from.id);
  const chatId = userChatId(message);
  const text = cleanText(message.text ?? "", 2500);
  const command = text.match(/^\/(\w+)(?:@\w+)?(?:\s|$)/)?.[1]?.toLowerCase();

  if (command === "start" || command === "menu") return handleStart(env, updateId, message);
  if (command === "cancel") {
    await clearSession(env.DB, userId);
    return isAdmin(userId, env)
      ? displayAdminMenu(env, updateId, chatId, "Действие отменено.")
      : displayUserMenu(env, updateId, chatId, "Действие отменено.");
  }
  if (command === "help") {
    return isAdmin(userId, env)
      ? displayAdminMenu(env, updateId, chatId, "Команды: /start, /cancel, /backup. Для архива добавьте бота в закрытую группу и отправьте /setarchive.")
      : displayUserMenu(env, updateId, chatId, "Используйте кнопки кабинета: заявка, просмотр оплаты и отправка фото/PDF чека.");
  }
  if (command === "backup") {
    if (!isAdmin(userId, env)) return sendUserText(env, updateId, chatId, "Нет доступа.", null, "access_denied");
    return showBackup(env, updateId, chatId, userId);
  }
  if (command === "csv") {
    if (!isAdmin(userId, env)) return sendUserText(env, updateId, chatId, "Нет доступа.", null, "access_denied");
    return exportCsv(env, updateId, chatId, userId);
  }
  if (command && isAdmin(userId, env)) {
    if (command === "clients") return showClients(env, updateId, chatId, 1);
    if (command === "requests") return showRequests(env, updateId, chatId, 1);
    if (command === "payments") return showPayments(env, updateId, chatId);
    if (command === "history") return showHistory(env, updateId, chatId);
  }

  const session = await getSession(env.DB, userId);
  if (session && (isAdmin(userId, env) || ["request", "receipt"].includes(session.flow))) {
    return handleUserSession(env, updateId, message, session);
  }
  if (extractMedia(message) && !isAdmin(userId, env)) {
    return sendUserText(env, updateId, chatId, "Сначала откройте «Мой кабинет», выберите сайт и только затем прикрепите фото или PDF чека.", USER_MENU, "receipt_without_flow");
  }
  if (isAdmin(userId, env)) return displayAdminMenu(env, updateId, chatId);
  return displayUserMenu(env, updateId, chatId, "В кабинете нельзя отправлять произвольные сообщения. Используйте кнопки; при оплате отправляется только фото или PDF чека.");
}

async function handleUpdate(env, updateId, update) {
  if (update.callback_query) return handleCallback(env, updateId, update.callback_query);
  if (update.message) return handleMessage(env, updateId, update.message);
}

async function registerWebhook(request, env) {
  if (!env.SETUP_KEY || !constantTimeEqual(request.headers.get("authorization") || "", `Bearer ${env.SETUP_KEY}`)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !adminIds(env).length) {
    return jsonResponse({ ok: false, error: "required_worker_secrets_or_database_missing" }, 503);
  }
  const url = new URL(request.url);
  if (!url.hostname.startsWith("kweb-service-bot.") || !url.hostname.endsWith(".workers.dev")) {
    return jsonResponse({ ok: false, error: "unexpected_worker_host" }, 400);
  }
  const webhookUrl = `${url.origin}/telegram/webhook`;
  try {
    await telegramApi(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
      max_connections: 10,
    });
    await telegramApi(env, "setMyCommands", {
      commands: [
        { command: "start", description: "Открыть меню" },
        { command: "cancel", description: "Отменить действие" },
        { command: "backup", description: "Резервная копия (администратор)" },
      ],
    });
    return jsonResponse({ ok: true, webhook: "registered" });
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof TelegramApiError ? `telegram_${error.errorCode || "error"}` : "telegram_setup_failed" }, 502);
  }
}

async function receiveWebhook(request, env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !adminIds(env).length) {
    return plainResponse("not configured", 503);
  }
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET)) return plainResponse("forbidden", 403);
  let update;
  try {
    update = await request.json();
  } catch {
    return plainResponse("bad json", 400);
  }
  const updateId = Number(update?.update_id);
  if (!Number.isSafeInteger(updateId) || updateId < 0) return plainResponse("invalid update", 400);
  const now = nowIso();
  await run(
    env.DB,
    "INSERT OR IGNORE INTO telegram_updates(update_id, status, attempts, received_at) VALUES(?, 'received', 0, ?)",
    updateId,
    now,
  );
  const stale = new Date(Date.now() - 120_000).toISOString();
  const claim = await run(
    env.DB,
    `UPDATE telegram_updates SET status='processing', attempts=attempts+1, received_at=?, last_error=NULL
     WHERE update_id=? AND (status IN ('received','failed') OR (status='processing' AND received_at < ?))`,
    now,
    updateId,
    stale,
  );
  if (!claim.meta?.changes) return plainResponse("ok");
  try {
    await handleUpdate(env, updateId, update);
    await run(env.DB, "UPDATE telegram_updates SET status='processed', processed_at=?, last_error=NULL WHERE update_id=?", nowIso(), updateId);
    await processOutbox(env, 25);
    return plainResponse("ok");
  } catch (error) {
    const code = error instanceof TelegramApiError ? `telegram_${error.errorCode || "error"}` : "processing_failed";
    await run(env.DB, "UPDATE telegram_updates SET status='failed', last_error=? WHERE update_id=?", code, updateId);
    return plainResponse("retry", 500);
  }
}

async function queueDailyReminders(env, date = localDateString(new Date(), env.APP_TIME_ZONE || "Europe/Moscow")) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
  const now = nowIso();
  const expired = await all(
    env.DB,
    `SELECT s.id, s.site_name, s.valid_through, s.payment_status, c.full_name, c.telegram_user_id
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active' AND s.payment_status='paid' AND s.valid_through < ? LIMIT 500`,
    date,
  );
  for (const service of expired) {
    const update = await run(env.DB, "UPDATE services SET payment_status='unpaid', updated_at=? WHERE id=? AND payment_status='paid' AND valid_through < ?", now, service.id, date);
    if (!update.meta?.changes) continue;
    const text = `Оплаченный период сайта ${service.site_name} у клиента ${service.full_name} закончился ${service.valid_through}; подтверждённой оплаты за новый период нет.`;
    await recordEvent(env, {
      action: "service_period_expired",
      entityType: "service",
      entityId: service.id,
      details: { periodEnd: service.valid_through },
      archiveText: text,
      archiveKey: `archive:service:${service.id}:expired:${service.valid_through}`,
    });
    await enqueueAdmins(env, `service-expired:${service.id}:${service.valid_through}`, text, null, "expiry_notice");
  }
  const services = await all(
    env.DB,
    `SELECT s.id, s.site_name, s.site_url, s.valid_through, s.payment_status,
       c.full_name, c.telegram_user_id
     FROM services s JOIN clients c ON c.id=s.client_id
     WHERE s.status='active' AND c.status='active'
     ORDER BY s.valid_through ASC LIMIT 1000`,
  );
  for (const service of services) {
    for (const milestone of reminderMilestones(service.valid_through, date)) {
      const inserted = await run(
        env.DB,
        `INSERT OR IGNORE INTO reminder_sends(service_id, period_end, milestone, status, created_at)
         VALUES(?, ?, ?, 'queued', ?)`,
        service.id,
        service.valid_through,
        milestone,
        now,
      );
      if (!inserted.meta?.changes) continue;
      const days = daysBetween(service.valid_through, date);
      const statusText = milestone === "before_3_days"
        ? `Подписка действует до ${service.valid_through} и скоро закончится.`
        : milestone === "end_day"
          ? `Подписка действует до конца сегодняшнего дня (${service.valid_through}).`
          : `Подписка не активна: срок закончился ${service.valid_through}.`;
      const text = `Здравствуйте!\n${statusText}\nЕсли вы уже отправили оплату, дождитесь подтверждения администратора.`;
      const key = `reminder:${service.id}:${service.valid_through}:${milestone}`;
      if (service.telegram_user_id) {
        const outboxId = await enqueueText(env, {
          target: "user",
          chatId: service.telegram_user_id,
          key,
          text,
          keyboard: inline([
            [button("Запросить реквизиты для оплаты", "receipt:start")],
            [button("Проверить подписку", "cabinet")],
          ]),
          category: "reminder",
          serviceId: service.id,
          periodEnd: service.valid_through,
        });
        await run(env.DB, "UPDATE reminder_sends SET outbox_id=? WHERE service_id=? AND period_end=? AND milestone=?", outboxId, service.id, service.valid_through, milestone);
      } else {
        await run(env.DB, "UPDATE reminder_sends SET status='failed' WHERE service_id=? AND period_end=? AND milestone=?", service.id, service.valid_through, milestone);
        await enqueueAdmins(env, `${key}:unlinked`, `${text}\nНапоминание не отправлено клиенту: кабинет Telegram не подключён.`, null, "reminder_unlinked");
        await enqueueArchive(env, `${key}:archive`, `Напоминание не отправлено: ${text}\nПричина: кабинет Telegram клиента не подключён.`, "reminder_unlinked", service.id, service.valid_through);
      }
      void days;
    }
  }
  await run(env.DB, "DELETE FROM user_sessions WHERE updated_at < ?", new Date(Date.now() - 86_400_000).toISOString());
}

async function scheduled(controller, env) {
  if (!env.DB) return;
  if (controller.cron === "0 6 * * *") {
    await queueDailyReminders(env);
  }
  await processOutbox(env, 50);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
      return jsonResponse({ ok: true, ready: Boolean(env.DB && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET && adminIds(env).length) });
    }
    if (url.pathname === "/setup/webhook" && request.method === "POST") return registerWebhook(request, env);
    if (url.pathname === "/telegram/webhook") {
      if (request.method !== "POST") return plainResponse("method not allowed", 405);
      return receiveWebhook(request, env);
    }
    return plainResponse("not found", 404);
  },
  async scheduled(controller, env) {
    try {
      await scheduled(controller, env);
    } catch (error) {
      console.error("scheduled_job_failed", error instanceof TelegramApiError ? `telegram_${error.errorCode}` : "internal_error");
    }
  },
};
