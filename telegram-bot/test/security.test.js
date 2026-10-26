import test from "node:test";
import assert from "node:assert/strict";
import { constantTimeEqual } from "../src/telegram-api.js";

test("constant-time secret comparator accepts identical and rejects different values", () => {
  assert.equal(constantTimeEqual("abc_123-XYZ", "abc_123-XYZ"), true);
  assert.equal(constantTimeEqual("abc_123-XYZ", "abc_123-XYz"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
});
