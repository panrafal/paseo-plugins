import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { latestTurnText } from "./inspect-usage";
import { clearTranscriptCaches, lastAssistantMessage } from "./transcript-tail";

const CLAUDE_TEXT =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 12am (Europe/Warsaw)";

const previousClaude = process.env.CLAUDE_CONFIG_DIR;
const previousCodex = process.env.CODEX_HOME;
let root = "";

before(async () => {
  root = await mkdtemp(join(tmpdir(), "chat-resume-transcript-"));
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
  clearTranscriptCaches();
});

after(async () => {
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  if (previousCodex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodex;
  clearTranscriptCaches();
  if (root) await rm(root, { recursive: true, force: true });
});

test("reads the last Claude assistant quota line from a jsonl tail", async () => {
  const directory = join(root, "claude", "projects", "-chat-resume-test-cwd");
  await mkdir(directory, { recursive: true });
  const lines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-10T20:17:44.913Z",
      message: { content: "keep going" },
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-10T20:18:39.177Z",
      isApiErrorMessage: true,
      message: { content: [{ type: "text", text: CLAUDE_TEXT }] },
    }),
    JSON.stringify({ type: "ai-title", title: "ignore me" }),
  ];
  await writeFile(join(directory, "sess.jsonl"), `${lines.join("\n")}\n`);
  const last = await lastAssistantMessage({
    provider: "claude",
    cwd: "/chat-resume-test-cwd",
    persistence: { sessionId: "sess" },
  });
  assert.equal(last?.text, CLAUDE_TEXT);
  assert.equal(last?.observedAt, "2026-09-10T20:18:39.177Z");
});

test("latestTurnText keeps output after the last user message", () => {
  const text = latestTurnText([
    { type: "user_message", text: "first" },
    { type: "assistant_message", text: "working" },
    { type: "user_message", text: "again" },
    { type: "assistant_message", text: CLAUDE_TEXT },
  ]);
  assert.equal(text, CLAUDE_TEXT);
});
