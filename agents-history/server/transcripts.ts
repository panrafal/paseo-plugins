import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { TranscriptReason } from "../shared/contracts";
import type { AgentRecord } from "./census";

/**
 * Finds the conversation files a provider keeps on disk for an agent. Paseo does not persist
 * timelines itself; it replays the provider's own transcript, so that file is the only thing
 * `grep` can search.
 *
 * - Claude Code: `<config>/projects/<encoded cwd>/<sessionId>.jsonl`, plus the subagent files
 *   under `<sessionId>/subagents/`. The encoding is ported from the daemon verbatim, with a
 *   session-id index over every project directory as the fallback when the cwd is gone or was
 *   encoded differently.
 * - Codex: `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl`, moved to
 *   `archived_sessions/` when Paseo archives the agent. Found through a cached index keyed by
 *   thread id.
 * - OMP, Pi, and anything else whose native handle is an absolute path to an existing file.
 * - ACP providers (Cursor, Kilo, Copilot, ...) keep no transcript on disk.
 */

export interface TranscriptFile {
  path: string;
  kind: "main" | "subagent";
}

export interface TranscriptResolution {
  files: TranscriptFile[];
  reason?: TranscriptReason;
}

const RESOLUTION_TTL_MS = 30_000;
const CLAUDE_INDEX_TTL_MS = 60_000;
const ROLLOUT_INDEX_TTL_MS = 30_000;
/** A lookup miss rebuilds the rollout index at most this often. */
const ROLLOUT_MISS_REBUILD_MS = 5_000;
const PROJECT_DIR_LENGTH_CAP = 200;
const ROLLOUT_FILE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

interface CachedResolution {
  key: string;
  resolvedAt: number;
  value: TranscriptResolution;
}

const resolutions = new Map<string, CachedResolution>();

interface FileIndex {
  builtAt: number;
  byId: Map<string, string[]>;
}

let claudeIndex: Promise<FileIndex> | null = null;
let rolloutIndex: Promise<FileIndex> | null = null;

export function clearTranscriptCaches(): void {
  resolutions.clear();
  claudeIndex = null;
  rolloutIndex = null;
}

export function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function codexHome(): string {
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

// --- Claude Code -------------------------------------------------------------------------------

/** Verbatim port of the daemon's `project-dir.ts`, which mirrors the Claude Agent SDK. */
function encodeProjectDir(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) return replaced;
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
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
    // The directory is gone (an archived worktree); fall through to the literal path.
  }
  candidates.add(join(root, encodeProjectDir(normalizeProjectPath(cwd))));
  return [...candidates];
}

async function buildClaudeIndex(): Promise<FileIndex> {
  const root = join(claudeRoot(), "projects");
  const byId = new Map<string, string[]>();
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

/** Subagent transcripts nest under `subagents/` and `subagents/workflows/<id>/`. */
async function collectSubagentFiles(sessionDirectory: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [join(sessionDirectory, "subagents")];
  while (queue.length > 0) {
    const directory = queue.shift() as string;
    for (const entry of await listDirectory(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && /^agent-.*\.jsonl$/.test(entry.name)) files.push(path);
    }
  }
  return files.sort();
}

async function resolveClaude(record: AgentRecord): Promise<TranscriptResolution> {
  const sessionId = record.persistence?.sessionId ?? record.persistence?.nativeHandle ?? null;
  if (!sessionId) return { files: [], reason: "no-session" };
  let main: string | null = null;
  for (const directory of await claudeProjectDirCandidates(record.cwd)) {
    const candidate = join(directory, `${sessionId}.jsonl`);
    if (await isFile(candidate)) {
      main = candidate;
      break;
    }
  }
  if (!main) main = (await lookupClaudeSession(sessionId))[0] ?? null;
  if (!main) return { files: [], reason: "file-missing" };
  const files: TranscriptFile[] = [{ path: main, kind: "main" }];
  const sessionDirectory = main.slice(0, -".jsonl".length);
  for (const path of await collectSubagentFiles(sessionDirectory)) {
    files.push({ path, kind: "subagent" });
  }
  return { files };
}

// --- Codex -----------------------------------------------------------------------------------

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

async function lookupRollout(threadId: string): Promise<string[]> {
  let index = await (rolloutIndex ??= buildRolloutIndex());
  const age = Date.now() - index.builtAt;
  const stale = age > ROLLOUT_INDEX_TTL_MS;
  const miss = !index.byId.has(threadId) && age > ROLLOUT_MISS_REBUILD_MS;
  if (stale || miss) {
    rolloutIndex = buildRolloutIndex();
    index = await rolloutIndex;
  }
  return index.byId.get(threadId) ?? [];
}

async function resolveCodex(record: AgentRecord): Promise<TranscriptResolution> {
  const threadId = record.persistence?.nativeHandle ?? record.persistence?.sessionId ?? null;
  if (!threadId) return { files: [], reason: "no-session" };
  const paths = await lookupRollout(threadId);
  const files: TranscriptFile[] = [];
  for (const path of paths) {
    if (await isFile(path)) files.push({ path, kind: "main" });
  }
  return files.length > 0 ? { files } : { files: [], reason: "file-missing" };
}

// --- Everything else -------------------------------------------------------------------------

const FILE_HANDLE_PROVIDERS = new Set(["omp", "pi"]);

async function resolveByHandle(record: AgentRecord): Promise<TranscriptResolution> {
  const handle = record.persistence?.nativeHandle ?? null;
  const expectsFile = FILE_HANDLE_PROVIDERS.has(record.provider);
  if (!handle || !isAbsolute(handle) || !basename(handle)) {
    return { files: [], reason: expectsFile ? "no-session" : "unsupported-provider" };
  }
  if (!(await isFile(handle))) {
    return { files: [], reason: expectsFile ? "file-missing" : "unsupported-provider" };
  }
  return { files: [{ path: handle, kind: "main" }] };
}

async function resolveUncached(record: AgentRecord): Promise<TranscriptResolution> {
  switch (record.provider) {
    case "claude":
      return resolveClaude(record);
    case "codex":
      return resolveCodex(record);
    default:
      return resolveByHandle(record);
  }
}

function resolutionKey(record: AgentRecord): string {
  return [
    record.provider,
    record.persistence?.sessionId ?? "",
    record.persistence?.nativeHandle ?? "",
    record.cwd,
  ].join(" ");
}

export async function resolveTranscripts(record: AgentRecord): Promise<TranscriptResolution> {
  const key = resolutionKey(record);
  const cached = resolutions.get(record.id);
  if (cached && cached.key === key && Date.now() - cached.resolvedAt < RESOLUTION_TTL_MS) {
    return cached.value;
  }
  const value = await resolveUncached(record);
  resolutions.set(record.id, { key, resolvedAt: Date.now(), value });
  return value;
}
