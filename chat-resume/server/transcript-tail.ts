import type { Dirent } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const PROJECT_DIR_LENGTH_CAP = 200;
const TAIL_BYTES = 64 * 1024;
const CLAUDE_INDEX_TTL_MS = 60_000;
const ROLLOUT_INDEX_TTL_MS = 30_000;
const ROLLOUT_MISS_REBUILD_MS = 5_000;
const ROLLOUT_FILE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const FILE_HANDLE_PROVIDERS = new Set(["omp", "pi"]);

export interface TranscriptAgent {
  provider: string;
  cwd: string;
  persistence?: {
    sessionId?: string | null;
    nativeHandle?: string | null;
  } | null;
}

export interface TranscriptMessage {
  text: string;
  observedAt: string;
}

interface FileIndex {
  builtAt: number;
  byId: Map<string, string[]>;
}

let claudeIndex: Promise<FileIndex> | null = null;
let rolloutIndex: Promise<FileIndex> | null = null;

export function clearTranscriptCaches(): void {
  claudeIndex = null;
  rolloutIndex = null;
}

function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function pushIndexed(index: Map<string, string[]>, id: string, path: string): void {
  const existing = index.get(id);
  if (existing) {
    if (!existing.includes(path)) existing.push(path);
  } else {
    index.set(id, [path]);
  }
}

function encodeProjectDir(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${Math.abs(hash).toString(36)}`;
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

async function claudeProjectDirCandidates(cwd: string): Promise<string[]> {
  const root = join(claudeRoot(), "projects");
  const candidates = new Set<string>();
  try {
    candidates.add(join(root, encodeProjectDir(normalizeProjectPath(await realpath(cwd)))));
  } catch {
    // Archived worktree or missing cwd; fall through to the literal path.
  }
  candidates.add(join(root, encodeProjectDir(normalizeProjectPath(cwd))));
  return [...candidates];
}

async function buildClaudeIndex(): Promise<FileIndex> {
  const byId = new Map<string, string[]>();
  const root = join(claudeRoot(), "projects");
  for (const project of await listDirectory(root)) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    for (const entry of await listDirectory(directory)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      pushIndexed(byId, entry.name.slice(0, -".jsonl".length), join(directory, entry.name));
    }
  }
  return { builtAt: Date.now(), byId };
}

async function lookupClaudeSession(sessionId: string): Promise<string[]> {
  let index = await (claudeIndex ??= buildClaudeIndex());
  if (Date.now() - index.builtAt > CLAUDE_INDEX_TTL_MS) {
    claudeIndex = buildClaudeIndex();
    index = await claudeIndex;
  }
  return index.byId.get(sessionId) ?? [];
}

async function resolveClaude(agent: TranscriptAgent): Promise<string | null> {
  const sessionId = agent.persistence?.sessionId ?? agent.persistence?.nativeHandle ?? null;
  if (!sessionId) return null;
  for (const directory of await claudeProjectDirCandidates(agent.cwd)) {
    const candidate = join(directory, `${sessionId}.jsonl`);
    if (await isFile(candidate)) return candidate;
  }
  return (await lookupClaudeSession(sessionId))[0] ?? null;
}

async function walkRollouts(root: string, byId: Map<string, string[]>): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    for (const entry of await listDirectory(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const match = ROLLOUT_FILE.exec(entry.name);
      if (match?.[1]) pushIndexed(byId, match[1], path);
    }
  }
}

async function buildRolloutIndex(): Promise<FileIndex> {
  const byId = new Map<string, string[]>();
  await walkRollouts(join(codexHome(), "sessions"), byId);
  await walkRollouts(join(codexHome(), "archived_sessions"), byId);
  return { builtAt: Date.now(), byId };
}

async function resolveCodex(agent: TranscriptAgent): Promise<string | null> {
  const threadId = agent.persistence?.nativeHandle ?? agent.persistence?.sessionId ?? null;
  if (!threadId) return null;
  let index = await (rolloutIndex ??= buildRolloutIndex());
  const age = Date.now() - index.builtAt;
  const miss = !index.byId.has(threadId) && age > ROLLOUT_MISS_REBUILD_MS;
  if (age > ROLLOUT_INDEX_TTL_MS || miss) {
    rolloutIndex = buildRolloutIndex();
    index = await rolloutIndex;
  }
  for (const path of index.byId.get(threadId) ?? []) {
    if (await isFile(path)) return path;
  }
  return null;
}

async function resolveHandle(agent: TranscriptAgent): Promise<string | null> {
  const handle = agent.persistence?.nativeHandle ?? null;
  if (!handle || !isAbsolute(handle) || !basename(handle)) return null;
  if (!(await isFile(handle))) return null;
  return handle;
}

async function resolveTranscriptPath(agent: TranscriptAgent): Promise<string | null> {
  switch (agent.provider) {
    case "claude":
      return resolveClaude(agent);
    case "codex":
      return resolveCodex(agent);
    default:
      return FILE_HANDLE_PROVIDERS.has(agent.provider) ? resolveHandle(agent) : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const text = asString(part.text);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

function extractClaude(record: Record<string, unknown>): TranscriptMessage | null {
  const timestamp = asString(record.timestamp);
  if (record.type === "assistant" && isRecord(record.message)) {
    const text = textParts(record.message.content).trim();
    if (text) return { text, observedAt: timestamp ?? new Date().toISOString() };
  }
  if (record.type === "result" && (record.is_error === true || record.isError === true)) {
    const text = (asString(record.result) ?? asString(record.error) ?? "").trim();
    if (text) return { text, observedAt: timestamp ?? new Date().toISOString() };
  }
  return null;
}

function extractCodex(record: Record<string, unknown>): TranscriptMessage | null {
  const timestamp = asString(record.timestamp);
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return null;
  const payloadType = asString(payload.type);
  if (record.type === "response_item" && payloadType === "message" && asString(payload.role) === "assistant") {
    const text = textParts(payload.content).trim();
    if (text) return { text, observedAt: timestamp ?? new Date().toISOString() };
  }
  if (record.type === "event_msg" && payloadType === "agent_message") {
    const text = (asString(payload.message) ?? "").trim();
    if (text) return { text, observedAt: timestamp ?? new Date().toISOString() };
  }
  return null;
}

function extractGeneric(record: Record<string, unknown>): TranscriptMessage | null {
  const timestamp = asString(record.timestamp);
  const message = isRecord(record.message) ? record.message : record;
  const role = asString(message.role) ?? asString(record.role) ?? asString(record.type);
  if (role !== "assistant") return null;
  const text = textParts(message.content ?? message.text ?? record.text).trim();
  if (!text) return null;
  return { text, observedAt: timestamp ?? new Date().toISOString() };
}

function extractMessage(raw: string, provider: string): TranscriptMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (provider === "claude") return extractClaude(parsed);
  if (provider === "codex") return extractCodex(parsed);
  return extractClaude(parsed) ?? extractCodex(parsed) ?? extractGeneric(parsed);
}

async function readTailLines(path: string): Promise<string[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    const start = Math.max(0, info.size - TAIL_BYTES);
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } finally {
    await handle.close();
  }
}

/** Last spoken assistant (or provider error) message in the agent's on-disk transcript. */
export async function lastAssistantMessage(agent: TranscriptAgent): Promise<TranscriptMessage | null> {
  const path = await resolveTranscriptPath(agent);
  if (!path) return null;
  try {
    const lines = await readTailLines(path);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const message = extractMessage(lines[index] ?? "", agent.provider);
      if (message) return message;
    }
  } catch (error) {
    if (!isMissing(error)) {
      console.error("[chat-resume] could not read transcript", path, error);
    }
  }
  return null;
}
