export class TelegramApiError extends Error {
  constructor(description, errorCode = 0, retryAfter = null) {
    super(String(description || "Telegram API request failed").slice(0, 240));
    this.name = "TelegramApiError";
    this.errorCode = Number(errorCode) || 0;
    this.retryAfter = Number(retryAfter) || null;
  }
}

export async function telegramApi(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot token is not configured");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ?? {}),
    });
  } catch {
    throw new TelegramApiError("Telegram network request failed");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramApiError(`Telegram returned HTTP ${response.status}`);
  }
  if (!response.ok || !data?.ok) {
    throw new TelegramApiError(
      data?.description || `Telegram returned HTTP ${response.status}`,
      data?.error_code,
      data?.parameters?.retry_after,
    );
  }
  return data.result;
}

export async function telegramSendDocument(env, chatId, filename, contents, mimeType = "application/json") {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot token is not configured");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([contents], { type: mimeType }), filename);
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new TelegramApiError("Telegram network request failed");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramApiError(`Telegram returned HTTP ${response.status}`);
  }
  if (!response.ok || !data?.ok) {
    throw new TelegramApiError(
      data?.description || `Telegram returned HTTP ${response.status}`,
      data?.error_code,
      data?.parameters?.retry_after,
    );
  }
  return data.result;
}

export function constantTimeEqual(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    difference |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return difference === 0;
}
