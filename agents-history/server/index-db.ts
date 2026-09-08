import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { IndexStatus } from "../shared/contracts";
import { paseoHome } from "./paseo-home";

/**
 * The search index is one SQLite file with two FTS5 tables: what was said, one row per message,
 * and one row of metadata per agent (title, workspace, project, branch, labels, path, model,
 * provider) that ranked search weights above the body. SQLite comes from Node's built-in
 * `node:sqlite`, so nothing has to be installed; a Node without it (or without FTS5) leaves
 * the plugin on the grep path.
 */

export const SCHEMA_VERSION = 1;
const LOG_PREFIX = "[agents-history]";
const BUSY_TIMEOUT_MS = 5_000;

export type IndexUnavailableReason = NonNullable<IndexStatus["reason"]>;

export interface IndexHandle {
  db: DatabaseSync;
  path: string;
}

export type OpenResult =
  | { ok: true; handle: IndexHandle }
  | { ok: false; reason: IndexUnavailableReason; message: string };

export const META_COLUMNS = [
  "title",
  "workspace",
  "project",
  "branch",
  "labels",
  "path",
  "model",
  "provider",
] as const;
export type MetaColumn = (typeof META_COLUMNS)[number];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms REAL NOT NULL DEFAULT 0,
    head_hash TEXT NOT NULL DEFAULT '',
    byte_offset INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT,
    error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS files_agent ON files(agent_id)`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    meta_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS agent_meta USING fts5(
    agent_id UNINDEXED, ${META_COLUMNS.join(", ")},
    tokenize = 'porter unicode61'
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
    text, agent_id UNINDEXED, file_id UNINDEXED, line UNINDEXED, role UNINDEXED, ts UNINDEXED,
    tokenize = 'porter unicode61'
  )`,
];

type SqliteModule = typeof import("node:sqlite");

function loadSqlite(): SqliteModule | null {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const loaded = getBuiltin.call(process, "node:sqlite") as SqliteModule | undefined;
    return loaded && typeof loaded.DatabaseSync === "function" ? loaded : null;
  } catch {
    return null;
  }
}

export function indexPath(): string {
  return (
    process.env.PASEO_AGENTS_HISTORY_DB ?? join(paseoHome(), "plugin-data", "agents-history", "search.sqlite")
  );
}

function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${path}${suffix}`, { force: true });
  }
}

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

function openAt(sqlite: SqliteModule, path: string): DatabaseSync {
  const db = new sqlite.DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens (creating if needed) the index. A database from another schema version, or one SQLite
 * reports as corrupt, is deleted and rebuilt from scratch; the transcripts are the source of
 * truth, the index only a cache of them.
 */
export function openIndex(): OpenResult {
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { ok: false, reason: "no-sqlite", message: "This Node.js has no built-in node:sqlite module." };
  }
  const path = indexPath();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { ok: false, reason: "open-failed", message: `Cannot create ${dirname(path)}: ${describe(error)}` };
  }

  let db: DatabaseSync | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      db = openAt(sqlite, path);
      const version = userVersion(db);
      if (version !== 0 && version !== SCHEMA_VERSION) {
        console.log(`${LOG_PREFIX} search index schema ${version} is not ${SCHEMA_VERSION}; rebuilding`);
        db.close();
        db = null;
        removeDatabaseFiles(path);
        continue;
      }
      for (const statement of SCHEMA) db.exec(statement);
      if (version === 0) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return { ok: true, handle: { db, path } };
    } catch (error) {
      const message = describe(error);
      try {
        db?.close();
      } catch {
        // Already unusable.
      }
      db = null;
      if (/fts5/i.test(message)) {
        return { ok: false, reason: "fts5-missing", message: "SQLite in this Node.js was built without FTS5." };
      }
      if (attempt === 0 && /malformed|not a database|corrupt/i.test(message)) {
        console.warn(`${LOG_PREFIX} search index is unusable (${message}); rebuilding`);
        removeDatabaseFiles(path);
        continue;
      }
      return { ok: false, reason: "open-failed", message };
    }
  }
  return { ok: false, reason: "open-failed", message: "Could not open the search index." };
}

export function closeIndex(handle: IndexHandle | null): void {
  if (!handle) return;
  try {
    handle.db.close();
  } catch (error) {
    console.warn(`${LOG_PREFIX} closing the search index failed: ${describe(error)}`);
  }
}
