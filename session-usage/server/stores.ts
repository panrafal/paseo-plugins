import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { estimateCost } from "../shared/pricing";
import { emptyMetrics, type Bucket, type Metrics, type MetricKey } from "../shared/schema";
import { COUNT_KEYS, compareBuckets, object, type ParsedTranscript } from "./parser";

/** A session read from a provider's SQLite store. `messages` lets the indexer skip empty sessions. */
export interface StoreSession { nativeId: string; parentId: string | null; archived: boolean; bytes: number; messages: number; parsed: ParsedTranscript }
export type StoreReader = (db: DatabaseSync, file: { mtimeMs: number }) => StoreSession[];

type SqliteModule = typeof import("node:sqlite");
type Row = Record<string, unknown>;

export function loadSqlite(): SqliteModule | null {
  const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== "function") return null;
  try {
    const loaded = getBuiltin.call(process, "node:sqlite") as SqliteModule | undefined;
    return loaded && typeof loaded.DatabaseSync === "function" ? loaded : null;
  } catch { return null; }
}

/** Opens the store read-only and closes it before returning; the provider may be writing to it. */
export function readStore(path: string, read: StoreReader, file: { mtimeMs: number }): StoreSession[] {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error("node:sqlite is unavailable");
  const db = new sqlite.DatabaseSync(path, { readOnly: true, timeout: 2_000 });
  try { return read(db, file); } finally { db.close(); }
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";
/** ISO strings, epoch seconds or epoch milliseconds. */
function iso(value: unknown): string | null {
  let ms = typeof value === "string" ? Date.parse(value) : num(value) ?? NaN;
  if (typeof value === "number" && ms < 1e12) ms *= 1000;
  return Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null;
}

/** Both stores record uncached input with disjoint cache reads and writes. */
function usage(model: string, input: number | null, output: number | null, read: number | null, write: number | null, reasoning: number | null): Metrics | null {
  if (input === null && output === null) return null;
  const m = emptyMetrics();
  m.uncachedTokens = input;
  m.cacheReadTokens = read ?? (input === null ? null : 0);
  m.cacheWriteTokens = write ?? (input === null ? null : 0);
  m.inputTokens = input === null ? null : input + (m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0);
  m.outputTokens = output;
  m.reasoningTokens = reasoning;
  m.requests = 1;
  m.estimatedCostUsd = estimateCost(model, m);
  return m;
}

class SessionBuilder {
  private buckets = new Map<string, Bucket>();
  private startedAt: string | null = null;
  private endedAt: string | null = null;
  bytes = 0;
  messages = 0;
  constructor(private countKeys: readonly MetricKey[]) {}

  time(at: string | null): void {
    if (!at) return;
    if (!this.startedAt || at < this.startedAt) this.startedAt = at;
    if (!this.endedAt || at > this.endedAt) this.endedAt = at;
  }
  add(at: string | null, model: string, effort: string | null, metrics: Partial<Metrics>, tool?: string): void {
    const day = at?.slice(0, 10) ?? "unknown";
    const hour = at ? Number(at.slice(11, 13)) : null;
    const key = JSON.stringify([day, hour, model, effort]);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { day, hour, model, effort, metrics: emptyMetrics(), tools: Object.create(null) as Record<string, number> };
      // Absence of a recorded event is a known zero only for measurements the store records.
      for (const metric of this.countKeys) bucket.metrics[metric] = 0;
      this.buckets.set(key, bucket);
    }
    for (const [metric, value] of Object.entries(metrics) as [MetricKey, number | null | undefined][]) {
      if (typeof value === "number") bucket.metrics[metric] = (bucket.metrics[metric] ?? 0) + value;
    }
    if (tool) bucket.tools[tool] = (bucket.tools[tool] ?? 0) + 1;
  }
  finish(base: Pick<ParsedTranscript, "nativeId" | "parentId" | "cwd" | "title" | "branch">, created: string | null, updated: string | null, missingTokens = "No token usage records found; token and cost measurements are unknown."): ParsedTranscript {
    const buckets = [...this.buckets.values()].sort(compareBuckets);
    const warnings = buckets.some((bucket) => bucket.metrics.inputTokens !== null) ? [] : [missingTokens];
    return { ...base, startedAt: this.startedAt ?? created, endedAt: this.endedAt ?? updated ?? created, buckets, warnings };
  }
}

/** OpenCode and its Kilo fork: `session`, `message` and `part` rows with JSON `data`. Only counters and lengths leave SQLite. */
export const readOpenCodeStore: StoreReader = (db) => {
  const columns = new Set((db.prepare("PRAGMA table_info(session)").all() as Row[]).map((column) => str(column.name)));
  const sessions = db.prepare(`SELECT id, parent_id AS parentId, directory, title, time_created AS created, time_updated AS updated,
    ${columns.has("time_archived") ? "time_archived" : "NULL"} AS archived FROM session`).all() as Row[];
  const messages = db.prepare(`SELECT id, session_id AS sessionId, time_created AS created,
    json_extract(data, '$.role') AS role, json_extract(data, '$.parentID') AS parentId,
    coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS model,
    json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
    json_extract(data, '$.tokens.reasoning') AS reasoning, json_extract(data, '$.tokens.cache.read') AS cacheRead,
    json_extract(data, '$.tokens.cache.write') AS cacheWrite, json_extract(data, '$.cost') AS cost,
    json_extract(data, '$.time.completed') AS completed, length(CAST(data AS BLOB)) AS bytes
    FROM message ORDER BY time_created, id`).all() as Row[];
  const parts = db.prepare(`SELECT message_id AS messageId, json_extract(data, '$.type') AS type, json_extract(data, '$.tool') AS tool,
    json_extract(data, '$.state.status') AS status, length(json_extract(data, '$.text')) AS textLength,
    length(json_extract(data, '$.state.input')) AS inputLength,
    length(coalesce(json_extract(data, '$.state.output'), json_extract(data, '$.state.error'))) AS outputLength,
    length(CAST(data AS BLOB)) AS bytes FROM part`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(COUNT_KEYS)]));
  const byMessage = new Map<string, { builder: SessionBuilder; at: string | null; model: string; role: string }>();
  const turns = new Map<string, { builder: SessionBuilder; start: number; end: number | null; model: string }>();
  for (const message of messages) {
    const builder = builders.get(str(message.sessionId));
    if (!builder) continue;
    const at = iso(message.created);
    const role = str(message.role);
    const model = str(message.model) || "unknown";
    builder.time(at);
    builder.time(iso(message.completed));
    builder.bytes += num(message.bytes) ?? 0;
    byMessage.set(str(message.id), { builder, at, model, role });
    if (role === "user") {
      builder.messages++;
      builder.add(at, model, null, { userMessages: 1 });
      const start = num(message.created);
      if (start !== null) turns.set(str(message.id), { builder, start, end: null, model });
    }
    if (role === "assistant") {
      builder.messages++;
      // OpenCode records reasoning separately from output; normalized output includes it.
      const output = num(message.output), reasoning = num(message.reasoning);
      const tokens = usage(model, num(message.input), output === null ? null : output + (reasoning ?? 0), num(message.cacheRead), num(message.cacheWrite), reasoning);
      const recorded = tokens && (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) > 0;
      builder.add(at, model, null, { ...(recorded ? tokens : {}), assistantMessages: 1, reportedCostUsd: num(message.cost) });
      // A turn runs from the user message to its last completed reply.
      const turn = turns.get(str(message.parentId));
      const completed = num(message.completed);
      if (turn && completed !== null) { turn.end = Math.max(turn.end ?? 0, completed); turn.model = model; }
    }
  }
  for (const turn of turns.values()) {
    if (turn.end !== null && turn.end >= turn.start) turn.builder.add(iso(turn.end), turn.model, null, { activeMs: turn.end - turn.start });
  }
  for (const part of parts) {
    const message = byMessage.get(str(part.messageId));
    if (!message) continue;
    const { builder, at, model, role } = message;
    builder.bytes += num(part.bytes) ?? 0;
    if (part.type === "text" && role === "user") builder.add(at, model, null, { userCharacters: num(part.textLength) ?? 0 });
    if (part.type === "text" && role === "assistant") builder.add(at, model, null, { assistantCharacters: num(part.textLength) ?? 0 });
    if (part.type === "tool") builder.add(at, model, null, { toolCalls: 1, toolErrors: part.status === "error" ? 1 : 0, toolInputCharacters: num(part.inputLength) ?? 0, toolOutputCharacters: num(part.outputLength) ?? 0 }, str(part.tool) || "unknown");
    if (part.type === "compaction") builder.add(at, model, null, { compactions: 1 });
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: str(row.parentId) || null, cwd: str(row.directory), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: base.parentId, archived: row.archived !== null && row.archived !== undefined, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};

const DEVIN_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
const EFFORT_SUFFIX = /^(.+)-(none|minimal|low|medium|high|xhigh|max)$/;
/** Devin CLI: a message forest per session. Compaction copies nodes, so messages and calls are deduplicated by ID. */
export const readDevinStore: StoreReader = (db) => {
  const sessions = db.prepare("SELECT id, working_directory AS cwd, title, created_at AS created, last_activity_at AS updated FROM sessions").all() as Row[];
  const nodes = db.prepare(`SELECT row_id AS rowId, session_id AS sessionId, created_at AS stored,
    json_extract(chat_message, '$.message_id') AS id, json_extract(chat_message, '$.role') AS role,
    json_extract(chat_message, '$.metadata.created_at') AS created,
    json_extract(chat_message, '$.metadata.generation_model') AS model,
    json_extract(chat_message, '$.metadata.telemetry.source') AS source,
    json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input,
    json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output,
    json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cacheRead,
    json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cacheWrite,
    json_extract(chat_message, '$.metadata.extensions."chisel/tool_result_meta".success') AS success,
    length(json_extract(chat_message, '$.content')) AS contentLength,
    length(CAST(chat_message AS BLOB)) AS bytes
    FROM message_nodes ORDER BY row_id`).all() as Row[];
  const calls = db.prepare(`SELECT n.session_id AS sessionId, json_extract(n.chat_message, '$.message_id') AS messageId,
    json_extract(t.value, '$.id') AS id, json_extract(t.value, '$.name') AS name, length(json_extract(t.value, '$.arguments')) AS inputLength
    FROM message_nodes n, json_each(n.chat_message, '$.tool_calls') t`).all() as Row[];

  const builders = new Map(sessions.map((row) => [str(row.id), new SessionBuilder(DEVIN_COUNT_KEYS)]));
  const contexts = new Map<string, { at: string | null; model: string; effort: string | null }>();
  const seen = new Set<string>();
  for (const node of nodes) {
    const sessionId = str(node.sessionId);
    const builder = builders.get(sessionId);
    if (!builder) continue;
    builder.bytes += num(node.bytes) ?? 0;
    const key = `${sessionId} ${str(node.id) || `row:${node.rowId}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = iso(node.created) ?? iso(node.stored);
    const context = { ...(contexts.get(sessionId) ?? { model: "unknown", effort: null }), at };
    builder.time(at);
    if (node.role === "assistant") {
      // Generation models carry the effort level as a suffix, e.g. "gpt-6-astra-medium".
      const model = str(node.model), match = EFFORT_SUFFIX.exec(model);
      if (model) { context.model = match ? match[1] : model; context.effort = match ? match[2] : null; }
      builder.messages++;
      const tokens = usage(context.model, num(node.input), num(node.output), num(node.cacheRead), num(node.cacheWrite), null);
      builder.add(at, context.model, context.effort, { ...tokens, assistantMessages: 1, assistantCharacters: num(node.contentLength) ?? 0 });
    }
    // Keepalive pings refresh the prompt cache; they are not user messages.
    if (node.role === "user" && node.source !== "cache_keepalive") {
      builder.messages++;
      builder.add(at, context.model, context.effort, { userMessages: 1, userCharacters: num(node.contentLength) ?? 0 });
    }
    if (node.role === "tool") builder.add(at, context.model, context.effort, { toolOutputCharacters: num(node.contentLength) ?? 0, toolErrors: node.success === 0 ? 1 : 0 });
    contexts.set(sessionId, context);
    contexts.set(key, context);
  }
  const seenCalls = new Set<string>();
  for (const call of calls) {
    const sessionId = str(call.sessionId);
    const builder = builders.get(sessionId);
    const key = `${sessionId} ${str(call.id) || `${str(call.messageId)}:${str(call.name)}`}`;
    if (!builder || seenCalls.has(key)) continue;
    seenCalls.add(key);
    const context = contexts.get(`${sessionId} ${str(call.messageId)}`);
    builder.add(context?.at ?? null, context?.model ?? "unknown", context?.effort ?? null, { toolCalls: 1, toolInputCharacters: num(call.inputLength) ?? 0 }, str(call.name) || "unknown");
  }
  return sessions.map((row) => {
    const builder = builders.get(str(row.id))!;
    const base = { nativeId: str(row.id), parentId: null, cwd: str(row.cwd), title: str(row.title).slice(0, 300), branch: "" };
    return { nativeId: base.nativeId, parentId: null, archived: false, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, iso(row.created), iso(row.updated)) };
  });
};

/** Length-delimited and varint fields of a protobuf message; null when the bytes are not one. */
function protobufFields(bytes: Uint8Array): { field: number; value: Uint8Array | number }[] | null {
  const fields: { field: number; value: Uint8Array | number }[] = [];
  let i = 0;
  const varint = () => {
    let value = 0, scale = 1;
    while (i < bytes.length) {
      const byte = bytes[i++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw new Error("truncated varint");
  };
  try {
    while (i < bytes.length) {
      const key = varint(), field = Math.floor(key / 8), wire = key % 8;
      if (wire === 0) fields.push({ field, value: varint() });
      else if (wire === 2) { const length = varint(); if (i + length > bytes.length) return null; fields.push({ field, value: bytes.subarray(i, i + length) }); i += length; }
      else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4;
      else return null;
    }
  } catch { return null; }
  return fields;
}

const CURSOR_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
const CURSOR_MODEL = /^(.+)-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/;
/**
 * Cursor agent: one store per session with content-addressed `blobs`. The latest root blob (protobuf) lists the
 * conversation's message IDs in order; older roots and edited-away messages stay in the table and are ignored.
 * Messages carry no timestamps or token usage.
 */
export const readCursorStore: StoreReader = (db, file) => {
  let meta: Record<string, unknown>;
  try { meta = object(JSON.parse(Buffer.from(str((db.prepare("SELECT value FROM meta WHERE key = '0'").get() as Row | undefined)?.value), "hex").toString("utf8"))); }
  catch { return []; }
  const nativeId = str(meta.agentId);
  if (!nativeId) return [];
  const root = (db.prepare("SELECT data FROM blobs WHERE id = ?").get(str(meta.latestRootBlobId)) as Row | undefined)?.data;
  const fields = root instanceof Uint8Array ? protobufFields(root) ?? [] : [];
  const text = (value: Uint8Array | number) => typeof value === "number" ? "" : Buffer.from(value).toString("utf8");
  const ids = fields.filter((f) => f.field === 1 && typeof f.value !== "number" && f.value.length === 32).map((f) => Buffer.from(f.value as Uint8Array).toString("hex"));
  const uri = fields.filter((f) => f.field === 9).map((f) => text(f.value)).find((value) => value.startsWith("file://"));
  let cwd = "";
  try { if (uri) cwd = fileURLToPath(uri); } catch { /* Not a local path. */ }
  const parts = db.prepare(`SELECT ids.key AS position, length(CAST(b.data AS BLOB)) AS bytes, json_extract(CAST(b.data AS TEXT), '$.role') AS role,
    iif(p.type = 'object', json_extract(p.value, '$.type'), 'text') AS type, iif(p.type = 'object', json_extract(p.value, '$.toolName'), NULL) AS tool,
    iif(p.type = 'object', json_extract(p.value, '$.providerOptions.cursor.modelName'), NULL) AS model,
    length(iif(p.type = 'text', p.value, iif(p.type = 'object', json_extract(p.value, '$.text'), NULL))) AS textLength,
    iif(p.type = 'object', length(json_extract(p.value, '$.args')), NULL) AS inputLength,
    iif(p.type = 'object', length(json_extract(p.value, '$.result')), NULL) AS outputLength,
    coalesce(json_type(CAST(b.data AS TEXT), '$.providerOptions.cursor.highLevelToolCallResult.output.error'),
      json_type(CAST(b.data AS TEXT), '$.providerOptions.cursor.highLevelToolCallResult.output.failure')) IS NOT NULL AS failed
    FROM json_each(?) ids JOIN blobs b ON b.id = ids.value,
    json_each(iif(json_valid(CAST(b.data AS TEXT)), CAST(b.data AS TEXT), '{}'), '$.content') p
    ORDER BY ids.key, p.id`).all(JSON.stringify(ids)) as Row[];

  const builder = new SessionBuilder(CURSOR_COUNT_KEYS);
  const created = iso(meta.createdAt);
  builder.time(created);
  builder.time(iso(file.mtimeMs));
  // Messages are undated, so everything lands on the session's start day. Early user messages take the first model.
  const modelOf = (value: string) => { const match = CURSOR_MODEL.exec(value); return match ? { model: `${match[1]}${match[3] ?? ""}`, effort: match[2] } : { model: value, effort: null }; };
  let context = modelOf(str(parts.find((part) => str(part.model))?.model) || str(meta.lastUsedModel) || "unknown");
  let position: unknown = null;
  for (const part of parts) {
    const role = str(part.role);
    if (part.model) context = modelOf(str(part.model));
    const { model, effort } = context;
    if (part.position !== position) {
      position = part.position;
      builder.bytes += num(part.bytes) ?? 0;
      if (role === "user") { builder.messages++; builder.add(created, model, effort, { userMessages: 1 }); }
      if (role === "assistant") { builder.messages++; builder.add(created, model, effort, { assistantMessages: 1 }); }
    }
    if (part.type === "text" && role === "user") builder.add(created, model, effort, { userCharacters: num(part.textLength) ?? 0 });
    if (part.type === "text" && role === "assistant") builder.add(created, model, effort, { assistantCharacters: num(part.textLength) ?? 0 });
    if (part.type === "tool-call") builder.add(created, model, effort, { toolCalls: 1, toolInputCharacters: num(part.inputLength) ?? 0 }, str(part.tool) || "unknown");
    if (part.type === "tool-result") builder.add(created, model, effort, { toolOutputCharacters: num(part.outputLength) ?? 0, toolErrors: part.failed ? 1 : 0 });
  }
  const base = { nativeId, parentId: null, cwd, title: str(meta.name).slice(0, 300), branch: "" };
  return [{ nativeId, parentId: null, archived: false, bytes: builder.bytes, messages: builder.messages, parsed: builder.finish(base, created, iso(file.mtimeMs), "Cursor keeps no token usage records locally; token and cost measurements are unknown.") }];
};

const ANTIGRAVITY_COUNT_KEYS = COUNT_KEYS.filter((key) => key !== "compactions");
/**
 * Antigravity agent: one store per session (`<sessionId>.db`).
 * Per-turn token usage and generation models are recorded in protobuf blobs in `gen_metadata`.
 * Individual user, assistant and tool steps are recorded in `steps`.
 */
export const readAntigravityStore: StoreReader = (db, file) => {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map((r) => str(r.name)));
  if (!tables.has("gen_metadata") && !tables.has("steps") && !tables.has("trajectory_meta")) return [];

  const traj = tables.has("trajectory_meta") ? (db.prepare("SELECT trajectory_id FROM trajectory_meta LIMIT 1").get() as Row | undefined) : undefined;
  const dbFile = (db.prepare("PRAGMA database_list").all() as Row[]).find((r) => r.name === "main")?.file;
  const fallbackId = typeof dbFile === "string" ? basename(dbFile, ".db") : "";
  const nativeId = str(traj?.trajectory_id) || fallbackId;
  if (!nativeId) return [];

  const builder = new SessionBuilder(ANTIGRAVITY_COUNT_KEYS);
  builder.time(iso(file.mtimeMs));

  let title = "";
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  if (tables.has("steps")) {
    const stepRows = db.prepare(`SELECT idx, step_type AS stepType, status,
      length(CAST(metadata AS BLOB)) + length(CAST(step_payload AS BLOB)) AS bytes,
      step_payload AS payload, metadata FROM steps ORDER BY idx`).all() as Row[];
    for (const row of stepRows) {
      builder.bytes += num(row.bytes) ?? 0;
      const payload = row.payload instanceof Uint8Array ? row.payload : null;
      const fields = payload ? protobufFields(payload) : null;

      // Extract timestamp if present in payload (field 5 -> field 1: sec, nano)
      let at: string | null = null;
      const f5 = fields?.find((f) => f.field === 5 && typeof f.value !== "number")?.value as Uint8Array | undefined;
      if (f5) {
        const f5Fields = protobufFields(f5);
        const tsMsg = f5Fields?.find((f) => f.field === 1 && typeof f.value !== "number")?.value as Uint8Array | undefined;
        if (tsMsg) {
          const tsFields = protobufFields(tsMsg);
          const sec = tsFields?.find((f) => f.field === 1 && typeof f.value === "number")?.value as number | undefined;
          const nano = tsFields?.find((f) => f.field === 2 && typeof f.value === "number")?.value as number | undefined;
          if (sec) at = new Date(sec * 1000 + Math.floor((nano ?? 0) / 1e6)).toISOString();
        }
      }
      if (at) {
        builder.time(at);
        if (!firstTimestamp) firstTimestamp = at;
        lastTimestamp = at;
      }

      const stepType = num(row.stepType);
      if (stepType === 14) {
        builder.messages++;
        const f19 = fields?.find((f) => f.field === 19 && typeof f.value !== "number")?.value as Uint8Array | undefined;
        let text = "";
        if (f19) {
          const f19Fields = protobufFields(f19);
          const f2 = f19Fields?.find((f) => f.field === 2 && typeof f.value !== "number")?.value as Uint8Array | undefined;
          if (f2) text = Buffer.from(f2).toString("utf8");
        }
        if (!title && text) {
          title = text.replace(/^(?:(?:\[Execution Guidance\]:?)|[#\s*-]+)+/i, "").trim().replace(/\s+/g, " ").slice(0, 300);
        }
        builder.add(at, "unknown", null, { userMessages: 1, userCharacters: text.length });
      } else if (stepType === 15) {
        builder.messages++;
        const f20 = fields?.find((f) => f.field === 20 && typeof f.value !== "number")?.value as Uint8Array | undefined;
        let asstTextLen = 0;
        let toolName: string | undefined;
        let toolInputLen = 0;
        if (f20) {
          const f20Fields = protobufFields(f20);
          const f1 = f20Fields?.find((f) => f.field === 1 && typeof f.value !== "number")?.value as Uint8Array | undefined;
          if (f1) asstTextLen = f1.length;
          const call = f20Fields?.find((f) => f.field === 7 && typeof f.value !== "number")?.value as Uint8Array | undefined;
          if (call) {
            const callFields = protobufFields(call);
            const nameVal = callFields?.find((f) => f.field === 2 && typeof f.value !== "number")?.value as Uint8Array | undefined;
            const inputVal = callFields?.find((f) => f.field === 3 && typeof f.value !== "number")?.value as Uint8Array | undefined;
            if (nameVal) toolName = Buffer.from(nameVal).toString("utf8");
            if (inputVal) toolInputLen = inputVal.length;
          }
        }
        builder.add(at, "unknown", null, { assistantMessages: 1, assistantCharacters: asstTextLen });
        if (toolName) builder.add(at, "unknown", null, { toolCalls: 1, toolInputCharacters: toolInputLen }, toolName);
      } else if (stepType === 7) {
        const metaBlob = row.metadata instanceof Uint8Array ? row.metadata : null;
        builder.add(at, "unknown", null, { toolOutputCharacters: (payload?.length ?? 0) + (metaBlob?.length ?? 0) });
      }
    }
  }

  if (tables.has("gen_metadata")) {
    const genRows = db.prepare("SELECT idx, data, size FROM gen_metadata ORDER BY idx").all() as Row[];
    for (const row of genRows) {
      const dataBlob = row.data instanceof Uint8Array ? row.data : null;
      if (!dataBlob) continue;
      builder.bytes += dataBlob.length;
      const top = protobufFields(dataBlob);
      const f1 = top?.find((f) => f.field === 1 && typeof f.value !== "number")?.value as Uint8Array | undefined;
      if (!f1) continue;
      const sub = protobufFields(f1);
      const f4 = sub?.find((f) => f.field === 4 && typeof f.value !== "number")?.value as Uint8Array | undefined;
      const f19 = sub?.find((f) => f.field === 19 && typeof f.value !== "number")?.value as Uint8Array | undefined;
      const model = f19 ? Buffer.from(f19).toString("utf8") : "unknown";

      let at: string | null = null;
      const f9 = sub?.find((f) => f.field === 9 && typeof f.value !== "number")?.value as Uint8Array | undefined;
      if (f9) {
        const f9Fields = protobufFields(f9);
        const tsBlob = f9Fields?.find((f) => f.field === 4 && typeof f.value !== "number")?.value as Uint8Array | undefined;
        if (tsBlob) {
          const tsFields = protobufFields(tsBlob);
          const sec = tsFields?.find((f) => f.field === 1 && typeof f.value === "number")?.value as number | undefined;
          const nano = tsFields?.find((f) => f.field === 2 && typeof f.value === "number")?.value as number | undefined;
          if (sec) at = new Date(sec * 1000 + Math.floor((nano ?? 0) / 1e6)).toISOString();
        }
      }
      at = at ?? lastTimestamp ?? firstTimestamp ?? iso(file.mtimeMs);
      builder.time(at);

      let input: number | null = null;
      let output: number | null = null;
      let reasoning: number | null = null;
      if (f4) {
        const tokens = protobufFields(f4);
        for (const t of tokens ?? []) {
          if (t.field === 2 && typeof t.value === "number") input = t.value;
          else if (t.field === 3 && typeof t.value === "number") output = t.value;
          else if (t.field === 9 && typeof t.value === "number") reasoning = t.value;
        }
      }
      const tokens = usage(model, input, output, null, null, reasoning);
      if (tokens && (tokens.inputTokens ?? 0) + (tokens.outputTokens ?? 0) > 0) {
        builder.add(at, model, null, tokens);
      }
    }
    if (!builder.messages && genRows.length > 0) {
      builder.messages = genRows.length;
    }
  }

  const base = { nativeId, parentId: null, cwd: "", title, branch: "" };
  const created = firstTimestamp ?? iso(file.mtimeMs);
  const updated = lastTimestamp ?? iso(file.mtimeMs);
  return [{
    nativeId,
    parentId: null,
    archived: false,
    bytes: builder.bytes,
    messages: builder.messages,
    parsed: builder.finish(base, created, updated, "Antigravity keeps no token usage records in this database; token and cost measurements are unknown.")
  }];
};

