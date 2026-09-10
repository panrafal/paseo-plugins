import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUsageExhaustedError,
  resumeAction,
  USAGE_NOTICE_MAX_CHARS,
  usageFromSources,
  usageResetAt,
} from "./usage";

const CLAUDE_MONTHLY =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 12am (Europe/Warsaw)";

test("detects Claude's monthly spend-limit assistant message", () => {
  assert.equal(isUsageExhaustedError(CLAUDE_MONTHLY), true);
  assert.equal(isUsageExhaustedError("You've hit your limit · resets 8pm (America/Los_Angeles)"), true);
  assert.equal(isUsageExhaustedError("usage limit reached; try again in 5 hours"), true);
  assert.equal(isUsageExhaustedError("Input length exceeds the context window limit"), false);
});

test("parses Claude's 12am Europe/Warsaw reset from the message timestamp", () => {
  const observed = new Date("2026-09-10T20:18:39.177Z");
  const resetAt = usageResetAt(CLAUDE_MONTHLY, observed);
  assert.ok(resetAt);
  assert.equal(resetAt.toISOString(), "2026-09-10T22:00:00.000Z");
  assert.equal(resumeAction(resetAt, new Date("2026-09-10T21:59:59.000Z")), "schedule");
  assert.equal(resumeAction(resetAt, new Date("2026-09-10T22:00:00.000Z")), "continue");
  assert.equal(resumeAction(resetAt, new Date("2026-09-11T08:00:00.000Z")), "continue");
});

test("continue is the action when no renewal time is parseable", () => {
  assert.equal(resumeAction(null), "continue");
  assert.equal(isUsageExhaustedError("insufficient quota"), true);
  assert.equal(usageResetAt("insufficient quota", "2026-09-10T12:00:00.000Z"), null);
});

test("relative renewal windows still parse", () => {
  const observed = new Date("2026-09-10T12:00:00.000Z");
  const resetAt = usageResetAt("rate limit exceeded; try again in 2 hours", observed);
  assert.ok(resetAt);
  assert.equal(resetAt.toISOString(), "2026-09-10T14:00:00.000Z");
});

test("usageFromSources prefers the first parseable reset among exhausted texts", () => {
  const match = usageFromSources([
    { text: "still working", observedAt: "2026-09-10T20:00:00.000Z" },
    { text: CLAUDE_MONTHLY, observedAt: "2026-09-10T20:18:39.177Z" },
  ]);
  assert.equal(match.exhausted, true);
  assert.equal(match.resetAt?.toISOString(), "2026-09-10T22:00:00.000Z");
});

test("ignores long replies that only quote a usage-limit notice", () => {
  const quoted = `${"Here is what the other agent said.\n".repeat(40)}\n${CLAUDE_MONTHLY}`;
  assert.equal(quoted.length > USAGE_NOTICE_MAX_CHARS, true);
  const match = usageFromSources([
    { text: quoted, observedAt: "2026-09-10T20:18:39.177Z", maxChars: USAGE_NOTICE_MAX_CHARS },
  ]);
  assert.equal(match.exhausted, false);
});
