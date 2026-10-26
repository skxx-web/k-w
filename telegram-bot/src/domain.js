export const DEFAULT_TIME_ZONE = "Europe/Moscow";

export function cleanText(value, max = 1000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, max);
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function localDateString(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function daysBetween(dateA, dateB) {
  if (!isIsoDate(dateA) || !isIsoDate(dateB)) throw new TypeError("Expected YYYY-MM-DD dates");
  const a = Date.parse(`${dateA}T00:00:00Z`);
  const b = Date.parse(`${dateB}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

export function addMonthsClamped(dateString, months = 1) {
  if (!isIsoDate(dateString) || !Number.isInteger(months)) throw new TypeError("Invalid date or month count");
  const [year, month, day] = dateString.split("-").map(Number);
  const targetIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonthIndex = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

export function renewalDate(validThrough, today) {
  if (!isIsoDate(validThrough) || !isIsoDate(today)) throw new TypeError("Invalid renewal date");
  const base = validThrough < today ? today : validThrough;
  return addMonthsClamped(base, 1);
}

export function reminderMilestones(validThrough, today) {
  const delta = daysBetween(validThrough, today);
  if (delta === 3) return ["before_3_days"];
  if (delta === 0) return ["end_day"];
  if (delta === -1) return ["after_1_day"];
  return [];
}

export function parseMoneyMinor(value) {
  const normalized = cleanText(value, 40)
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/₽|руб(?:\.|лей|ля)?/gi, "")
    .replace(",", ".");
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) return null;
  return Math.round(amount * 100);
}

export function formatMoney(minor, currency = "RUB") {
  const amount = Number(minor);
  if (!Number.isSafeInteger(amount) || amount < 0) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount / 100);
}

export function isSafeHttpUrl(value) {
  const text = cleanText(value, 500);
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function csvCell(value) {
  let text = String(value ?? "").replace(/[\r\n]+/g, " ");
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows, headers) {
  return [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\r\n");
}

export function csvSafeFilenamePart(value) {
  return cleanText(value, 40).replace(/[^a-zA-Z0-9_-]/g, "_") || "export";
}
