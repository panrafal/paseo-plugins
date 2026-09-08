import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { AgentMatch, SearchError, Snippet, SnippetRole, searchHistory } from "../shared/contracts";
import { type AgentRecord, loadAgentRecords } from "./census";
import { getIndexHandle, getIndexStatus, requestSync } from "./indexer";
import { rankedSearch } from "./ranked-search";
import { PARSE_CAP, type SnippetSource, buildLocator, extractSnippet } from "./snippets";
import { type TranscriptFile, resolveTranscripts } from "./transcripts";

/**
 * Entry point for a search. Ranked mode answers from the FTS5 index; regex mode, a Node without
 * SQLite, or an index that has not been built yet fall through to the system `grep` over the
 * transcript files of the requested agents, whose hits become per-agent snippets. One grep
 * invocation covers every file (chunked only if the argument list would grow huge); its stdout
 * is parsed as a stream because a single transcript line can be several megabytes and a common
 * word produces tens of megabytes of hits.
 */

type SearchInput = RpcInput<typeof searchHistory>;
type SearchOutput = RpcOutput<typeof searchHistory>;

const LOG_PREFIX = "[agents-history]";
const TIMEOUT_MS = 20_000;
/** Total bytes of grep output parsed before the search is cut short. */
const OUTPUT_CAP_BYTES = 64 * 1024 * 1024;
/** Longest hit line kept; the rest of a longer line is dropped. */
const LINE_CAP_BYTES = PARSE_CAP;
/**
 * Upper bound on `grep -m`. grep returns the first hits in file order, and a query that also
 * sits in a record field (a branch or directory name) matches every line, so the quota is
 * over-fetched to leave room for hits inside what was said.
 */
const PER_FILE_MAX = 20;
/** Sum of path lengths per grep invocation. */
const ARGV_CHUNK_BYTES = 100_000;
const MAX_ACTIVE = 2;
const STDERR_CAP = 4_000;

const ROLE_RANK: Record<SnippetRole, number> = { user: 0, assistant: 1, tool: 2, other: 3 };
/** A hit inside what was said beats one that only sits in the record's JSON fields, whoever said it. */
const SOURCE_RANK: Record<SnippetSource, number> = { text: 0, raw: 1, none: 2 };

interface CollectedSnippet {
  snippet: Snippet;
  source: SnippetSource;
}

interface SearchTarget {
  agentId: string;
  provider: string;
  file: TranscriptFile;
}

interface AgentCollector {
  snippets: Map<string, CollectedSnippet>;
  hitCount: number;
  /** Some file of this agent produced the per-file maximum, so more hits likely exist. */
  saturated: boolean;
  perFile: Map<string, number>;
}

interface Inflight {
  controller: AbortController;
}

const inflight = new Map<string, Inflight>();
let active = 0;

export function abortAllSearches(): void {
  for (const entry of inflight.values()) entry.controller.abort();
  inflight.clear();
}

function emptyResult(overrides: Partial<SearchOutput> = {}): SearchOutput {
  return {
    matches: [],
    searchedAgents: 0,
    unsearchableAgents: [],
    durationMs: 0,
    outputTruncated: false,
    ...overrides,
  };
}

export async function runSearch(input: SearchInput): Promise<SearchOutput> {
  const key = input.clientKey ?? randomUUID();
  inflight.get(key)?.controller.abort();
  if (active >= MAX_ACTIVE) {
    return emptyResult({
      error: { code: "busy", message: "Another history search is still running. Try again in a moment." },
    });
  }
  const controller = new AbortController();
  inflight.set(key, { controller });
  active += 1;
  try {
    return await dispatch(input, controller.signal);
  } finally {
    active -= 1;
    if (inflight.get(key)?.controller === controller) inflight.delete(key);
  }
}

async function dispatch(input: SearchInput, signal: AbortSignal): Promise<SearchOutput> {
  if (input.regex || input.mode === "regex") {
    return { ...(await execute(input, signal)), mode: "regex" };
  }
  const handle = getIndexHandle();
  const status = getIndexStatus();
  if (!handle) {
    return { ...(await execute(input, signal)), mode: "regex", fallback: "no-sqlite", index: status };
  }
  if (status.indexedFiles === 0) {
    // First open on this host: grep answers now while the index is being built.
    requestSync("search");
    return { ...(await execute(input, signal)), mode: "regex", fallback: "index-empty", index: getIndexStatus() };
  }
  if (status.stale) requestSync("search");
  const records = new Map((await loadAgentRecords()).map((record) => [record.id, record] as const));
  if (signal.aborted) {
    return emptyResult({ error: { code: "superseded", message: "A newer search replaced this one." } });
  }
  return { ...rankedSearch(input, handle, records), index: getIndexStatus() };
}

function compareByActivity(a: AgentRecord, b: AgentRecord): number {
  const left = Date.parse(a.lastActivityAt ?? a.updatedAt ?? a.createdAt) || 0;
  const right = Date.parse(b.lastActivityAt ?? b.updatedAt ?? b.createdAt) || 0;
  return right - left;
}

async function collectTargets(
  input: SearchInput,
): Promise<{ targets: SearchTarget[]; unsearchable: string[]; searched: number }> {
  const wanted = new Set(input.agentIds);
  const records = (await loadAgentRecords()).filter((record) => wanted.has(record.id));
  records.sort(compareByActivity);
  const found = new Set(records.map((record) => record.id));
  const unsearchable = input.agentIds.filter((id) => !found.has(id));
  const targets: SearchTarget[] = [];
  let searched = 0;
  for (const record of records) {
    const resolution = await resolveTranscripts(record);
    if (resolution.files.length === 0) {
      unsearchable.push(record.id);
      continue;
    }
    searched += 1;
    for (const file of resolution.files) {
      targets.push({ agentId: record.id, provider: record.provider, file });
    }
  }
  return { targets, unsearchable, searched };
}

/** Splits targets into argv-sized chunks without separating one agent's files. */
function chunkTargets(targets: readonly SearchTarget[]): SearchTarget[][] {
  const chunks: SearchTarget[][] = [];
  let current: SearchTarget[] = [];
  let bytes = 0;
  let index = 0;
  while (index < targets.length) {
    const agentId = targets[index]?.agentId;
    const group: SearchTarget[] = [];
    while (index < targets.length && targets[index]?.agentId === agentId) {
      group.push(targets[index] as SearchTarget);
      index += 1;
    }
    const groupBytes = group.reduce((sum, target) => sum + Buffer.byteLength(target.file.path) + 1, 0);
    if (current.length > 0 && bytes + groupBytes > ARGV_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(...group);
    bytes += groupBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function grepArguments(input: SearchInput, perFileLimit: number, paths: readonly string[]): string[] {
  const args = ["-n", "-H", "-a", "-s", "--null", "-m", String(perFileLimit)];
  if (!input.caseSensitive) args.push("-i");
  args.push(input.regex ? "-E" : "-F");
  args.push("--", input.query, ...paths);
  return args;
}

interface HitHandler {
  (path: string, lineNumber: number, content: Buffer, clipped: boolean): void;
}

/**
 * Splits grep's stdout into `<path>\0<line>:<content>` records without ever holding more than
 * one capped line in memory. Only the tail of an over-long line is dropped, and a cut can only
 * fall inside a multi-byte sequence there, where a replacement character is harmless.
 */
function attachLineParser(stdout: Readable, onHit: HitHandler, onBytes: (count: number) => void): void {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let dropping = false;

  const emit = (line: Buffer, clipped: boolean) => {
    const nul = line.indexOf(0);
    if (nul === -1) return;
    const rest = line.subarray(nul + 1);
    const colon = rest.indexOf(58);
    if (colon === -1) return;
    const lineNumber = Number(rest.subarray(0, colon).toString("latin1"));
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) return;
    onHit(line.subarray(0, nul).toString("utf8"), lineNumber, rest.subarray(colon + 1), clipped);
  };

  stdout.on("data", (chunk: Buffer) => {
    onBytes(chunk.length);
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      if (newline === -1) {
        if (!dropping) {
          pending.push(chunk.subarray(start));
          pendingBytes += chunk.length - start;
          if (pendingBytes > LINE_CAP_BYTES) {
            emit(Buffer.concat(pending).subarray(0, LINE_CAP_BYTES), true);
            pending = [];
            pendingBytes = 0;
            dropping = true;
          }
        }
        return;
      }
      if (!dropping) {
        pending.push(chunk.subarray(start, newline));
        emit(Buffer.concat(pending), false);
      }
      pending = [];
      pendingBytes = 0;
      dropping = false;
      start = newline + 1;
    }
  });
  stdout.on("end", () => {
    if (!dropping && pendingBytes > 0) emit(Buffer.concat(pending), false);
  });
}

interface GrepOutcome {
  code: number | null;
  stderr: string;
  spawnError: NodeJS.ErrnoException | null;
  aborted: boolean;
}

function runGrep(
  args: string[],
  signal: AbortSignal,
  onHit: HitHandler,
  onBytes: (count: number) => void,
): Promise<GrepOutcome> {
  return new Promise((resolvePromise) => {
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;
    let settled = false;
    const finish = (outcome: GrepOutcome) => {
      if (settled) return;
      settled = true;
      resolvePromise(outcome);
    };
    const child = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"], signal });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.name === "AbortError") {
        finish({ code: null, stderr, spawnError: null, aborted: true });
        return;
      }
      spawnError = error;
      finish({ code: null, stderr, spawnError, aborted: false });
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
    });
    if (child.stdout) attachLineParser(child.stdout, onHit, onBytes);
    child.on("close", (code) => {
      finish({ code, stderr, spawnError, aborted: signal.aborted });
    });
  });
}

function classifyFailure(stderr: string): SearchError {
  const message = stderr.trim().replace(/^grep:\s*/gm, "").split("\n")[0] ?? "";
  if (/unmatched|invalid|trailing backslash|brace|regular expression|character class|repetition/i.test(message)) {
    return { code: "invalid-regex", message: message || "The regular expression is invalid." };
  }
  return { code: "grep-failed", message: message || "grep failed on the daemon host." };
}

async function execute(input: SearchInput, signal: AbortSignal): Promise<SearchOutput> {
  const startedAt = Date.now();
  const { targets, unsearchable, searched } = await collectTargets(input);
  if (signal.aborted) {
    return emptyResult({ error: { code: "superseded", message: "A newer search replaced this one." } });
  }
  if (targets.length === 0) {
    return emptyResult({ unsearchableAgents: unsearchable, searchedAgents: searched, durationMs: Date.now() - startedAt });
  }

  const perFileLimit = Math.min(PER_FILE_MAX, Math.max(input.perAgentLimit * 4, 8));
  const locate = buildLocator(input.query, { regex: input.regex, caseSensitive: input.caseSensitive });
  const byPath = new Map<string, SearchTarget>();
  for (const target of targets) byPath.set(target.file.path, target);
  const collectors = new Map<string, AgentCollector>();
  let totalBytes = 0;
  let outputTruncated = false;
  let timedOut = false;

  // Supersession, the timeout, and the output cap all stop the same child through one signal.
  const stopController = new AbortController();
  const stop = () => stopController.abort();
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, TIMEOUT_MS);
  const combined = stopController.signal;

  const onHit: HitHandler = (path, lineNumber, content, clipped) => {
    const target = byPath.get(path);
    if (!target) return;
    let collector = collectors.get(target.agentId);
    if (!collector) {
      collector = { snippets: new Map(), hitCount: 0, saturated: false, perFile: new Map() };
      collectors.set(target.agentId, collector);
    }
    collector.hitCount += 1;
    const fileHits = (collector.perFile.get(path) ?? 0) + 1;
    collector.perFile.set(path, fileHits);
    if (fileHits >= perFileLimit) collector.saturated = true;
    const { body, source } = extractSnippet(content.toString("utf8"), target.provider, locate, clipped);
    const dedupeKey = `${body.role}\u0000${body.before}${body.match}${body.after}`;
    if (collector.snippets.has(dedupeKey)) return;
    collector.snippets.set(dedupeKey, {
      snippet: { file: target.file.kind, lineNumber, ...body },
      source,
    });
  };
  const onBytes = (count: number) => {
    totalBytes += count;
    if (totalBytes > OUTPUT_CAP_BYTES && !outputTruncated) {
      outputTruncated = true;
      stop();
    }
  };

  let error: SearchError | undefined;
  try {
    for (const chunk of chunkTargets(targets)) {
      if (combined.aborted) break;
      const args = grepArguments(input, perFileLimit, chunk.map((target) => target.file.path));
      const outcome = await runGrep(args, combined, onHit, onBytes);
      if (outcome.spawnError) {
        error =
          outcome.spawnError.code === "ENOENT"
            ? { code: "grep-failed", message: "grep is not installed on the daemon host." }
            : { code: "grep-failed", message: outcome.spawnError.message };
        break;
      }
      if (outcome.aborted) break;
      if (outcome.code === 2) {
        if (collectors.size === 0 && !outputTruncated) {
          error = classifyFailure(outcome.stderr);
          break;
        }
        console.warn(`${LOG_PREFIX} grep reported a problem but returned hits: ${outcome.stderr.trim().slice(0, 300)}`);
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }

  if (signal.aborted) {
    return emptyResult({ error: { code: "superseded", message: "A newer search replaced this one." } });
  }
  if (timedOut && !error) {
    error = { code: "timeout", message: "The history search took too long and was cut short." };
  }

  const matches: AgentMatch[] = [];
  for (const [agentId, collector] of collectors) {
    let ordered = [...collector.snippets.values()].sort(
      (a, b) =>
        SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
        ROLE_RANK[a.snippet.role] - ROLE_RANK[b.snippet.role] ||
        a.snippet.lineNumber - b.snippet.lineNumber,
    );
    if (ordered.some((entry) => entry.snippet.role !== "other")) {
      ordered = ordered.filter((entry) => entry.snippet.role !== "other");
    }
    const kept = ordered.slice(0, input.perAgentLimit).map((entry) => entry.snippet);
    if (kept.length === 0) continue;
    matches.push({
      agentId,
      snippets: kept,
      truncated: kept.length < collector.snippets.size || collector.saturated,
      hitCount: collector.hitCount,
    });
  }
  const order = new Map(targets.map((target, index) => [target.agentId, index] as const));
  matches.sort((a, b) => (order.get(a.agentId) ?? 0) - (order.get(b.agentId) ?? 0));

  return {
    matches,
    searchedAgents: searched,
    unsearchableAgents: unsearchable,
    durationMs: Date.now() - startedAt,
    outputTruncated,
    ...(error ? { error } : {}),
  };
}
