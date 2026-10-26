import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped,
  csvCell,
  daysBetween,
  formatMoney,
  isIsoDate,
  isValidEmail,
  isSafeHttpUrl,
  localDateString,
  normalizeTelegramUsername,
  parseMoneyMinor,
  reminderMilestones,
  renewalDate,
  toCsv,
} from "../src/domain.js";

test("validates real ISO calendar dates", () => {
  assert.equal(isIsoDate("2028-02-29"), true);
  assert.equal(isIsoDate("2027-02-29"), false);
  assert.equal(isIsoDate("2027-2-09"), false);
});

test("uses Moscow local calendar date across UTC midnight", () => {
  assert.equal(localDateString(new Date("2026-10-26T22:30:00.000Z")), "2026-10-27");
});

test("calculates calendar day differences", () => {
  assert.equal(daysBetween("2026-10-30", "2026-10-27"), 3);
  assert.equal(daysBetween("2026-10-26", "2026-10-27"), -1);
});

test("clamps renewal dates at month end and leap years", () => {
  assert.equal(addMonthsClamped("2027-01-31"), "2027-02-28");
  assert.equal(addMonthsClamped("2028-01-31"), "2028-02-29");
  assert.equal(addMonthsClamped("2028-12-31"), "2029-01-31");
});

test("renews from paid-through date when current, and from today when overdue", () => {
  assert.equal(renewalDate("2026-11-20", "2026-11-10"), "2026-12-20");
  assert.equal(renewalDate("2026-11-01", "2026-11-05"), "2026-12-05");
});

test("reminder milestones are exactly once-per-date candidates", () => {
  assert.deepEqual(reminderMilestones("2026-11-01", "2026-10-29"), ["before_3_days"]);
  assert.deepEqual(reminderMilestones("2026-11-01", "2026-11-01"), ["end_day"]);
  assert.deepEqual(reminderMilestones("2026-11-01", "2026-11-02"), ["after_1_day"]);
  assert.deepEqual(reminderMilestones("2026-11-01", "2026-10-30"), []);
});

test("parses and formats RUB amounts using integer kopecks", () => {
  assert.equal(parseMoneyMinor("10 000,50 ₽"), 1_000_050);
  assert.equal(parseMoneyMinor("7500"), 750_000);
  assert.equal(parseMoneyMinor("-10"), null);
  assert.equal(parseMoneyMinor("abc"), null);
  assert.equal(formatMoney(1_000_000, "RUB"), "10 000 ₽");
});

test("accepts only credential-free HTTP(S) URLs", () => {
  assert.equal(isSafeHttpUrl("https://example.com/path"), true);
  assert.equal(isSafeHttpUrl("ftp://example.com"), false);
  assert.equal(isSafeHttpUrl("https://user:pass@example.com"), false);
  assert.equal(isSafeHttpUrl("not a URL"), false);
});

test("CSV exports quote values and neutralize spreadsheet formulas", () => {
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell("=1+1"), "\"'=1+1\"");
  assert.match(toCsv([{ name: "=CMD()" }], ["name"]), /'=CMD\(\)/);
});

test("normalizes optional Telegram usernames without exposing numeric IDs", () => {
  assert.equal(normalizeTelegramUsername("@Kweb_client"), "@Kweb_client");
  assert.equal(normalizeTelegramUsername("Kweb_client"), "@Kweb_client");
  assert.equal(normalizeTelegramUsername("-"), null);
  assert.equal(normalizeTelegramUsername("123456789"), undefined);
  assert.equal(normalizeTelegramUsername("bad space"), undefined);
});

test("validates e-mail addresses and rejects missing or malformed values", () => {
  assert.equal(isValidEmail("client@example.com"), true);
  assert.equal(isValidEmail("a+b@example.ru"), true);
  assert.equal(isValidEmail("no-at.example.com"), false);
  assert.equal(isValidEmail("client@localhost"), false);
  assert.equal(isValidEmail(""), false);
});
