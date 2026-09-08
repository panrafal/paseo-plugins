import { createHash } from "node:crypto";
import { type FileHandle, open, stat } from "node:fs/promises";
import type { StatementSync } from "node:sqlite";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { IndexStatus } from "../shared/contracts";
import {
  type AgentRecord,
  type ProjectRecord,
  type WorkspaceRecord,
  buildWorkspaceLookup,
  loadCensusRecords,
  mapWithConcurrency,
  resolveWorkspace,
} from "./census";
import { type IndexHandle, type IndexUnavailableReason, META_COLUMNS, closeIndex, openIndex } from "./index-db";
import { PARSE_CAP, classifyLine } from "./snippets";
import { type TranscriptFile, resolveTranscripts } from "./transcripts";

/**
 * Keeps the search index in step with the transcripts. It runs only when asked: when the history
 * surface loads or refreshes its census, and when a ranked search finds the index stale. There
 * is no watcher and no timer while nothing is looking.
 *
 * Transcripts are append-only JSONL, so each file remembers how many bytes were consumed and a
 * later run reads only what was added. A file that shrank or whose first bytes changed is
 * rebuilt. Work happens in small batches, each its own transaction, with the event loop
 * released in between so searches and shutdown never wait more than one batch.
 */

const LOG_PREFIX = "[agents-history]";
/** Two runs are never closer than this; a request in between is folded into one later run. */
const MIN_INTERVAL_MS = 15_000;
const READ_CHUNK_BYTES = 1024 * 1024;
const HEAD_HASH_BYTES = 512;
const BATCH_LINES = 512;
const BATCH_BYTES = 4 * 1024 * 1024;
const BATCH_MS = 40;
/** A message longer than this is split into several rows on the same line. */
const CHUNK_TEXT_MAX = 16 * 1024;
const DEDUPE_RING = 16;
const RESOLVE_CONCURRENCY = 16;
const NEWLINE = 10;

type State = IndexStatus["state"];

interface FileRow {
  id: number;
  path: string;
  agent_id: string;
  provider: string;
  kind: string;
  size: number;
  mtime_ms: number;
  head_hash: string;
  byte_offset: number;
  line_count: number;
  chunk_count: number;
  indexed_at: string | null;
  error: string | null;
}

interface PlannedFile {
  path: string;
  kind: TranscriptFile["kind"];
  agentId: string;
  provider: string;
}

interface Job {
  file: PlannedFile;
  row: FileRow;
  size: number;
  mtimeMs: number;
  headHash: string;
  rebuild: boolean;
}

interface Statements {
  selectFiles: StatementSync;
  selectFileByPath: StatementSync;
  insertFile: StatementSync;
  resetFile: StatementSync;
  progress: StatementSync;
  finishFile: StatementSync;
  failFile: StatementSync;
  deleteChunksOfFile: StatementSync;
  deleteFile: StatementSync;
  insertChunk: StatementSync;
  selectAgentHash: StatementSync;
  deleteMeta: StatementSync;
  insertMeta: StatementSync;
  upsertAgent: StatementSync;
  selectAgents: StatementSync;
  deleteAgent: StatementSync;
  countChunks: StatementSync;
  fileTotals: StatementSync;
  agentTotals: StatementSync;
}

interface PendingChunk {
  text: string;
  line: number;
  role: string;
  ts: string | null;
}

let handle: IndexHandle | null = null;
let statements: Statements | null = null;
let opened = false;
let unavailable: { reason: IndexUnavailableReason; message: string } | null = null;

let state: State = "idle";
let running: Promise<void> | null = null;
let rerunRequested = false;
let stopping = false;
let timer: NodeJS.Timeout | null = null;
let lastRunStartedAt = 0;
let lastRunAt: string | null = null;
let lastError: string | null = null;
/** No run has answered the latest request yet. */
let stale = true;
let counters = { indexedFiles: 0, totalFiles: 0, indexedAgents: 0, totalAgents: 0, chunks: 0 };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepare(db: IndexHandle["db"]): Statements {
  const metaColumns = META_COLUMNS.join(", ");
  const metaPlaceholders = META_COLUMNS.map(() => "?").join(", ");
  return {
    selectFiles: db.prepare("SELECT * FROM files"),
    selectFileByPath: db.prepare("SELECT * FROM files WHERE path = ?"),
    insertFile: db.prepare("INSERT INTO files (path, agent_id, provider, kind) VALUES (?, ?, ?, ?)"),
    resetFile: db.prepare(
      "UPDATE files SET byte_offset = 0, line_count = 0, chunk_count = 0, indexed_at = NULL, error = NULL WHERE id = ?",
    ),
    progress: db.prepare("UPDATE files SET byte_offset = ?, line_count = ?, chunk_count = ? WHERE id = ?"),
    finishFile: db.prepare(
      "UPDATE files SET size = ?, mtime_ms = ?, head_hash = ?, byte_offset = ?, line_count = ?, chunk_count = ?, indexed_at = ?, error = NULL WHERE id = ?",
    ),
    failFile: db.prepare("UPDATE files SET error = ? WHERE id = ?"),
    deleteChunksOfFile: db.prepare("DELETE FROM chunks WHERE file_id = ?"),
    deleteFile: db.prepare("DELETE FROM files WHERE id = ?"),
    insertChunk: db.prepare("INSERT INTO chunks (text, agent_id, file_id, line, role, ts) VALUES (?, ?, ?, ?, ?, ?)"),
    selectAgentHash: db.prepare("SELECT meta_hash FROM agents WHERE id = ?"),
    deleteMeta: db.prepare("DELETE FROM agent_meta WHERE agent_id = ?"),
    insertMeta: db.prepare(`INSERT INTO agent_meta (agent_id, ${metaColumns}) VALUES (?, ${metaPlaceholders})`),
    upsertAgent: db.prepare(
      "INSERT INTO agents (id, meta_hash, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET meta_hash = excluded.meta_hash, updated_at = excluded.updated_at",
    ),
    selectAgents: db.prepare("SELECT id FROM agents"),
    deleteAgent: db.prepare("DELETE FROM agents WHERE id = ?"),
    countChunks: db.prepare("SELECT COUNT(*) AS count FROM chunks"),
    fileTotals: db.prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN indexed_at IS NOT NULL AND error IS NULL THEN 1 ELSE 0 END) AS done FROM files",
    ),
    agentTotals: db.prepare(
      "SELECT COUNT(*) AS total, SUM(done) AS done FROM (SELECT agent_id, MIN(CASE WHEN indexed_at IS NOT NULL AND error IS NULL THEN 1 ELSE 0 END) AS done FROM files GROUP BY agent_id)",
    ),
  };
}

/** The open index, or null when this Node cannot provide one. Opened on first use. */
export function getIndexHandle(): IndexHandle | null {
  if (opened) return handle;
  opened = true;
  const result = openIndex();
  if (result.ok) {
    handle = result.handle;
    statements = prepare(handle.db);
    try {
      refreshCounters();
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not read the search index totals: ${describe(error)}`);
    }
    console.log(`${LOG_PREFIX} search index at ${handle.path}`);
  } else {
    unavailable = { reason: result.reason, message: result.message };
    state = "unavailable";
    console.warn(`${LOG_PREFIX} ranked search unavailable: ${result.message}`);
  }
  return handle;
}

export function getIndexStatus(): IndexStatus {
  if (!opened) getIndexHandle();
  return {
    available: handle !== null,
    ...(unavailable ? { reason: unavailable.reason } : {}),
    state,
    ...counters,
    stale: handle !== null && (stale || rerunRequested),
    lastRunAt,
    lastError: lastError ?? unavailable?.message ?? null,
  };
}

function refreshCounters(): void {
  if (!statements) return;
  const files = statements.fileTotals.get() as { total: number; done: number | null };
  const agents = statements.agentTotals.get() as { total: number; done: number | null };
  const chunks = statements.countChunks.get() as { count: number };
  counters = {
    indexedFiles: Number(files.done ?? 0),
    totalFiles: Number(files.total),
    indexedAgents: Number(agents.done ?? 0),
    totalAgents: Number(agents.total),
    chunks: Number(chunks.count),
  };
}

/** Asks for a sync; coalesced with a run in progress and throttled to one per interval. */
export function requestSync(reason: string): void {
  if (stopping) return;
  if (!opened) getIndexHandle();
  if (!handle) return;
  stale = true;
  if (running) {
    rerunRequested = true;
    return;
  }
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRunStartedAt);
  if (wait > 0) {
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        requestSync(reason);
      }, wait);
      timer.unref();
    }
    return;
  }
  lastRunStartedAt = Date.now();
  running = runOnce(reason)
    .catch((error) => {
      lastError = describe(error);
      console.warn(`${LOG_PREFIX} index run failed: ${lastError}`);
    })
    .finally(() => {
      running = null;
      state = handle ? "idle" : "unavailable";
      lastRunAt = new Date().toISOString();
      if (rerunRequested && !stopping) {
        rerunRequested = false;
        requestSync("rerun");
      }
    });
}

/** Stops after the current batch and closes the database. */
export async function stopIndexer(): Promise<void> {
  stopping = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (running) await running;
  closeIndex(handle);
  handle = null;
  statements = null;
}

async function runOnce(reason: string): Promise<void> {
  if (!handle || !statements) return;
  const db = handle.db;
  const sql = statements;
  const startedAt = Date.now();
  state = "planning";
  lastError = null;
  stale = false;

  const census = await loadCensusRecords();
  if (stopping) return;
  const lookup = buildWorkspaceLookup(census.workspaces);
  const projects = new Map(census.projects.map((project) => [project.projectId, project]));
  const agentIds = new Set<string>();
  for (const agent of census.agents) {
    agentIds.add(agent.id);
    const workspace = resolveWorkspace(agent, lookup);
    const project = workspace?.projectId ? (projects.get(workspace.projectId) ?? null) : null;
    upsertMetadata(agent, workspace, project);
  }

  const resolutions = await mapWithConcurrency(census.agents, RESOLVE_CONCURRENCY, async (agent) => ({
    agent,
    files: (await resolveTranscripts(agent)).files,
  }));
  if (stopping) return;
  const planned = new Map<string, PlannedFile>();
  for (const { agent, files } of resolutions) {
    for (const file of files) {
      if (planned.has(file.path)) continue;
      planned.set(file.path, { path: file.path, kind: file.kind, agentId: agent.id, provider: agent.provider });
    }
  }

  const rows = new Map<string, FileRow>();
  for (const row of sql.selectFiles.all() as unknown as FileRow[]) rows.set(row.path, row);

  const planItems = [...planned.values()];
  const statted = await mapWithConcurrency(planItems, RESOLVE_CONCURRENCY, async (file) => {
    try {
      const info = await stat(file.path);
      return { file, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return { file, size: -1, mtimeMs: 0 };
    }
  });
  if (stopping) return;
  const jobs: Job[] = [];
  for (const { file, size, mtimeMs } of statted) {
    if (size < 0) continue;
    let row = rows.get(file.path);
    if (!row) {
      sql.insertFile.run(file.path, file.agentId, file.provider, file.kind);
      row = sql.selectFileByPath.get(file.path) as unknown as FileRow | undefined;
      if (!row) continue;
      rows.set(file.path, row);
    }
    const settled = row.indexed_at !== null && row.error === null;
    if (settled && row.size === size && row.mtime_ms === mtimeMs) continue;
    const headHash = await hashHead(file.path, size);
    const rebuild =
      row.byte_offset > 0 && (size < row.byte_offset || (row.head_hash !== "" && headHash !== row.head_hash));
    jobs.push({ file, row, size, mtimeMs, headHash, rebuild });
  }
  rows.clear();

  state = "indexing";
  counters.totalFiles = planned.size;
  let touched = 0;
  for (const job of jobs) {
    if (stopping) break;
    try {
      await indexFile(job);
      touched += 1;
    } catch (error) {
      const message = describe(error);
      console.warn(`${LOG_PREFIX} could not index a transcript of agent ${job.file.agentId}: ${message}`);
      try {
        sql.failFile.run(message.slice(0, 500), job.row.id);
      } catch {
        // The failure is already logged.
      }
    }
    refreshCounters();
  }
  if (stopping) return;

  state = "housekeeping";
  db.exec("BEGIN");
  try {
    for (const row of sql.selectFiles.all() as unknown as FileRow[]) {
      if (planned.has(row.path)) continue;
      sql.deleteChunksOfFile.run(row.id);
      sql.deleteFile.run(row.id);
    }
    for (const entry of sql.selectAgents.all() as unknown as { id: string }[]) {
      if (agentIds.has(entry.id)) continue;
      sql.deleteMeta.run(entry.id);
      sql.deleteAgent.run(entry.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  refreshCounters();
  if (jobs.length > 0) {
    console.log(
      `${LOG_PREFIX} index sync (${reason}): ${touched} of ${jobs.length} files updated, ${counters.chunks} messages indexed, ${Date.now() - startedAt} ms`,
    );
  }
}

function metadataDocument(
  agent: AgentRecord,
  workspace: WorkspaceRecord | null,
  project: ProjectRecord | null,
): Record<(typeof META_COLUMNS)[number], string> {
  const paths = new Set<string>([agent.cwd]);
  if (workspace?.cwd) paths.add(workspace.cwd);
  if (project?.rootPath) paths.add(project.rootPath);
  return {
    title: agent.title?.trim() ?? "",
    workspace: [workspace?.displayName, workspace?.title].filter(Boolean).join(" "),
    project: [project?.customName, project?.displayName].filter(Boolean).join(" "),
    branch: workspace?.branch ?? "",
    labels: (workspace?.labels ?? []).join(" "),
    path: [...paths].join(" "),
    model: agent.config?.model ?? agent.runtimeInfo?.model ?? "",
    provider: agent.provider,
  };
}

function upsertMetadata(agent: AgentRecord, workspace: WorkspaceRecord | null, project: ProjectRecord | null): void {
  if (!handle || !statements) return;
  const doc = metadataDocument(agent, workspace, project);
  const values = META_COLUMNS.map((column) => doc[column]);
  const hash = createHash("sha1").update(JSON.stringify(values)).digest("hex");
  const existing = statements.selectAgentHash.get(agent.id) as { meta_hash: string } | undefined;
  if (existing?.meta_hash === hash) return;
  const db = handle.db;
  db.exec("BEGIN");
  try {
    statements.deleteMeta.run(agent.id);
    statements.insertMeta.run(agent.id, ...values);
    statements.upsertAgent.run(agent.id, hash, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function hashHead(path: string, size: number): Promise<string> {
  if (size === 0) return "";
  let fd: FileHandle | null = null;
  try {
    fd = await open(path, "r");
    const buffer = Buffer.allocUnsafe(Math.min(HEAD_HASH_BYTES, size));
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    return createHash("sha1").update(buffer.subarray(0, bytesRead)).digest("hex");
  } catch {
    return "";
  } finally {
    await fd?.close();
  }
}

/** A cheap check before JSON parsing: only these record shapes can hold a message. */
function mightHoldMessage(line: string, provider: string): boolean {
  switch (provider) {
    case "claude":
      return line.includes('"type":"user"') || line.includes('"type":"assistant"');
    case "codex":
      // Codex also mirrors each message into event_msg records; response_item is the canonical one.
      return line.includes('"response_item"');
    default:
      return true;
  }
}

async function indexFile(job: Job): Promise<void> {
  if (!handle || !statements) return;
  const db = handle.db;
  const sql = statements;
  const { file, row } = job;

  if (job.rebuild) {
    db.exec("BEGIN");
    try {
      sql.deleteChunksOfFile.run(row.id);
      sql.resetFile.run(row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    row.byte_offset = 0;
    row.line_count = 0;
    row.chunk_count = 0;
  }

  let offset = row.byte_offset;
  let lineCount = row.line_count;
  let chunkCount = row.chunk_count;
  const ring: string[] = [];
  let batch: PendingChunk[] = [];
  let batchBytes = 0;
  let batchLines = 0;
  let batchStartedAt = Date.now();

  const insertBatch = () => {
    for (const chunk of batch) {
      sql.insertChunk.run(chunk.text, file.agentId, row.id, chunk.line, chunk.role, chunk.ts);
    }
    batch = [];
    batchBytes = 0;
    batchLines = 0;
    batchStartedAt = Date.now();
  };

  const commitProgress = () => {
    db.exec("BEGIN");
    try {
      insertBatch();
      sql.progress.run(offset, lineCount, chunkCount, row.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const handleLine = (raw: Buffer, lineNumber: number) => {
    const line = raw.toString("utf8");
    if (!mightHoldMessage(line, file.provider)) return;
    const extracted = classifyLine(line, file.provider);
    if (!extracted || (extracted.role !== "user" && extracted.role !== "assistant")) return;
    const text = extracted.text.trim();
    if (text.length === 0) return;
    // Injected context (system notes, tool manifests) is wrapped in a tag; nobody typed it.
    if (extracted.role === "user" && text.startsWith("<")) return;
    const key = `${extracted.role} ${text}`;
    if (ring.includes(key)) return;
    ring.push(key);
    if (ring.length > DEDUPE_RING) ring.shift();
    for (let start = 0; start < text.length; start += CHUNK_TEXT_MAX) {
      batch.push({
        text: text.slice(start, start + CHUNK_TEXT_MAX),
        line: lineNumber,
        role: extracted.role,
        ts: extracted.timestamp ?? null,
      });
      chunkCount += 1;
    }
  };

  const fd = await open(file.path, "r");
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = offset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let dropping = false;
    let interrupted = false;
    while (!interrupted) {
      const { bytesRead } = await fd.read(buffer, 0, READ_CHUNK_BYTES, position);
      if (bytesRead === 0) break;
      const view = buffer.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const newline = view.indexOf(NEWLINE, start);
        if (newline === -1) {
          if (!dropping) {
            // The buffer is reused by the next read, so the partial line is copied out.
            pending.push(Buffer.from(view.subarray(start)));
            pendingBytes += bytesRead - start;
            if (pendingBytes > PARSE_CAP) {
              pending = [];
              pendingBytes = 0;
              dropping = true;
            }
          }
          break;
        }
        lineCount += 1;
        if (!dropping) {
          pending.push(view.subarray(start, newline));
          handleLine(pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending), lineCount);
        }
        const lineBytes = pendingBytes + (newline - start) + 1;
        pending = [];
        pendingBytes = 0;
        dropping = false;
        offset = position + newline + 1;
        start = newline + 1;
        batchLines += 1;
        batchBytes += lineBytes;
        if (batchLines >= BATCH_LINES || batchBytes >= BATCH_BYTES || Date.now() - batchStartedAt >= BATCH_MS) {
          commitProgress();
          await yieldToLoop();
          if (stopping) {
            interrupted = true;
            break;
          }
        }
      }
      position += bytesRead;
    }
    if (interrupted) {
      // Progress so far is committed; the next run resumes from the stored offset.
      return;
    }
    // A trailing partial line is a write in progress; it is left for the next run.
    db.exec("BEGIN");
    try {
      insertBatch();
      sql.finishFile.run(
        job.size,
        job.mtimeMs,
        job.headHash,
        offset,
        lineCount,
        chunkCount,
        new Date().toISOString(),
        row.id,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    await fd.close();
  }
}
