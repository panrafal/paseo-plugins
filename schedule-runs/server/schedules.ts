import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DEFAULT_RUN_LIMIT,
  type RunAgent,
  type RunPullRequest,
  type RunRow,
  type RunWorkspace,
  type ScheduleSummary,
  type listScheduleRuns,
} from "../shared/contracts";
import { countByStatus, describeCadence, findPullRequestUrl } from "../shared/model";
import { paseoHome } from "./paseo-home";

/**
 * The plugin SDK has no schedules namespace, so the run feed is assembled from what the daemon
 * leaves on disk: one JSON file per schedule under `$PASEO_HOME/schedules` (each carrying its
 * run records, including the agent's final response) and the workspace registry under
 * `$PASEO_HOME/projects/workspaces.json`, which is the only place archived workspaces remain
 * listed. Agents, archived ones included, come from the SDK's agent directory.
 */

const LOG_PREFIX = "[schedule-runs]";
/** Label the daemon stamps on every agent a schedule run creates. */
const RUN_LABEL = "paseo.schedule-run";
/** Recorded outputs are cut here so one talkative run cannot dominate the payload. */
const OUTPUT_MAX_CHARS = 50_000;
const PAGE_LIMIT = 200;
/** Ceiling on directory pages so an enormous history cannot spin forever. */
const MAX_PAGES = 25;
const DIRECTORY_CACHE_TTL_MS = 10_000;

/**
 * Mirrors the daemon's `StoredScheduleSchema` loosely: only the fields the feed reads are
 * required, ids are plain strings rather than GUIDs, and unknown keys pass through so a newer
 * daemon does not make every file unreadable.
 */
const PersistedRunSchema = z.object({
  id: z.string(),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable().optional(),
  status: z.enum(["running", "succeeded", "failed"]),
  agentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

const PersistedScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  cadence: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("cron"),
      expression: z.string(),
      timezone: z.string().nullable().optional(),
    }),
    z.object({ type: z.literal("every"), everyMs: z.number().int().positive() }),
  ]),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("agent"), agentId: z.string() }),
    z.object({
      type: z.literal("new-agent"),
      config: z
        .object({
          provider: z.string().optional(),
          cwd: z.string().optional(),
          title: z.string().nullable().optional(),
        })
        .passthrough(),
    }),
  ]),
  status: z.enum(["active", "paused", "completed"]),
  nextRunAt: z.string().nullable().optional(),
  lastRunAt: z.string().nullable().optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  runs: z.array(z.unknown()),
});

type PersistedRun = z.output<typeof PersistedRunSchema>;
type PersistedSchedule = Omit<z.output<typeof PersistedScheduleSchema>, "runs"> & {
  runs: PersistedRun[];
};

const WorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  /** The merged change request whose automatic archive the daemon consumed. */
  autoArchivedChangeRequestUrl: z.string().nullable().optional(),
});

type WorkspaceRecord = z.output<typeof WorkspaceRecordSchema>;

interface CachedFile<Value> {
  mtimeMs: number;
  size: number;
  value: Value;
}

interface AgentIndex {
  byId: ReadonlyMap<string, PaseoAgent>;
  /** Agents keyed by the run id in their `paseo.schedule-run` label. */
  byRunId: ReadonlyMap<string, PaseoAgent>;
}

/** Live workspaces keyed by id; the only source of a pull request for a workspace still open. */
type WorkspaceIndex = ReadonlyMap<string, PaseoWorkspace>;

interface CachedDirectory<Value> {
  fetchedAt: number;
  promise: Promise<Value>;
}

const scheduleFiles = new Map<string, CachedFile<PersistedSchedule | null>>();
let workspaceFile: CachedFile<ReadonlyMap<string, WorkspaceRecord>> | null = null;
let agentIndex: CachedDirectory<AgentIndex> | null = null;
let workspaceIndex: CachedDirectory<WorkspaceIndex> | null = null;

export function clearRunCaches(): void {
  scheduleFiles.clear();
  workspaceFile = null;
  agentIndex = null;
  workspaceIndex = null;
}

function scheduleDirectory(): string {
  return join(paseoHome(), "schedules");
}

function workspaceRegistryPath(): string {
  return join(paseoHome(), "projects", "workspaces.json");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Re-parses a file only when its size or mtime moved. The daemon rewrites a schedule file on
 * every run transition, and the registry on every workspace change, so this is what keeps a
 * 15-second poll from re-reading megabytes of unchanged JSON.
 */
async function readCachedJson<Value>(
  path: string,
  cached: CachedFile<Value> | undefined,
  parse: (raw: unknown) => Value,
): Promise<CachedFile<Value> | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return { mtimeMs: info.mtimeMs, size: info.size, value: parse(raw) };
}

function parseSchedule(raw: unknown, fileName: string): PersistedSchedule | null {
  const parsed = PersistedScheduleSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn(`${LOG_PREFIX} ignoring invalid schedule file ${fileName}`);
    return null;
  }
  const runs: PersistedRun[] = [];
  for (const candidate of parsed.data.runs) {
    const run = PersistedRunSchema.safeParse(candidate);
    if (run.success) runs.push(run.data);
    else console.warn(`${LOG_PREFIX} ignoring invalid run record in ${fileName}`);
  }
  return { ...parsed.data, runs };
}

async function readSchedules(): Promise<PersistedSchedule[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(scheduleDirectory(), { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const seen = new Set<string>();
  const schedules: PersistedSchedule[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(scheduleDirectory(), entry.name);
    seen.add(path);
    try {
      const file = await readCachedJson(path, scheduleFiles.get(path), (raw) =>
        parseSchedule(raw, entry.name),
      );
      if (!file) {
        scheduleFiles.delete(path);
        continue;
      }
      scheduleFiles.set(path, file);
      if (file.value) schedules.push(file.value);
    } catch (error) {
      console.warn(`${LOG_PREFIX} could not read schedule file ${entry.name}: ${String(error)}`);
    }
  }
  for (const path of scheduleFiles.keys()) {
    if (!seen.has(path)) scheduleFiles.delete(path);
  }
  return schedules;
}

function parseWorkspaceRegistry(raw: unknown): ReadonlyMap<string, WorkspaceRecord> {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { workspaces?: unknown }).workspaces)
      ? ((raw as { workspaces: unknown[] }).workspaces)
      : [];
  const records = new Map<string, WorkspaceRecord>();
  for (const candidate of list) {
    const parsed = WorkspaceRecordSchema.safeParse(candidate);
    if (parsed.success) records.set(parsed.data.workspaceId, parsed.data);
  }
  return records;
}

async function readWorkspaceRegistry(): Promise<ReadonlyMap<string, WorkspaceRecord>> {
  try {
    const file = await readCachedJson(
      workspaceRegistryPath(),
      workspaceFile ?? undefined,
      parseWorkspaceRegistry,
    );
    workspaceFile = file;
    return file?.value ?? new Map();
  } catch (error) {
    console.warn(`${LOG_PREFIX} could not read the workspace registry: ${String(error)}`);
    return workspaceFile?.value ?? new Map();
  }
}

async function fetchAgentIndex(paseo: PaseoApi): Promise<AgentIndex> {
  const byId = new Map<string, PaseoAgent>();
  const byRunId = new Map<string, PaseoAgent>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, cursor },
    });
    for (const entry of result.entries) {
      const agent = entry.agent;
      byId.set(agent.id, agent);
      const runId = agent.labels?.[RUN_LABEL];
      if (runId) byRunId.set(runId, agent);
    }
    const nextCursor = result.pageInfo.nextCursor;
    if (!result.pageInfo.hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return { byId, byRunId };
}

async function fetchWorkspaceIndex(paseo: PaseoApi): Promise<WorkspaceIndex> {
  const byId = new Map<string, PaseoWorkspace>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.workspaces.list({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: PAGE_LIMIT, cursor },
    });
    for (const workspace of result.entries) byId.set(workspace.id, workspace);
    const nextCursor = result.pageInfo.nextCursor;
    if (!result.pageInfo.hasMore || !nextCursor) break;
    cursor = nextCursor;
  }
  return byId;
}

/** One directory walk per TTL window, shared by every request that lands inside it. */
function cachedDirectory<Value>(
  current: CachedDirectory<Value> | null,
  store: (next: CachedDirectory<Value> | null) => void,
  fetch: () => Promise<Value>,
): Promise<Value> {
  const now = Date.now();
  if (current && now - current.fetchedAt < DIRECTORY_CACHE_TTL_MS) return current.promise;
  const entry = { fetchedAt: now, promise: fetch() };
  store(entry);
  entry.promise.catch(() => {
    // Drop a failed walk so the next request retries instead of serving the rejection.
    store(null);
  });
  return entry.promise;
}

function cachedAgentIndex(paseo: PaseoApi): Promise<AgentIndex> {
  return cachedDirectory(
    agentIndex,
    (next) => {
      agentIndex = next;
    },
    () => fetchAgentIndex(paseo),
  );
}

function cachedWorkspaceIndex(paseo: PaseoApi): Promise<WorkspaceIndex> {
  return cachedDirectory(
    workspaceIndex,
    (next) => {
      workspaceIndex = next;
    },
    () => fetchWorkspaceIndex(paseo),
  );
}

function pullRequestState(
  pullRequest: NonNullable<NonNullable<PaseoWorkspace["githubRuntime"]>["pullRequest"]>,
): RunPullRequest["state"] {
  const raw = pullRequest.state.toLowerCase();
  if (pullRequest.isMerged || raw === "merged") return "merged";
  if (raw === "open") return "open";
  if (raw === "closed") return "closed";
  return null;
}

/**
 * The daemon only knows a pull request for a workspace that is still open. Once archived, the
 * registry keeps the URL only when the archive was the automatic one on merge; failing both,
 * the first pull request the agent linked in its response is the best remaining evidence.
 */
function toPullRequest(
  live: PaseoWorkspace | undefined,
  record: WorkspaceRecord | undefined,
  output: string | null,
): RunPullRequest | null {
  const fromWorkspace = live?.githubRuntime?.pullRequest;
  if (fromWorkspace?.url) {
    return {
      url: fromWorkspace.url,
      number: fromWorkspace.number ?? findPullRequestUrl(fromWorkspace.url)?.number ?? null,
      title: fromWorkspace.title ?? null,
      state: pullRequestState(fromWorkspace),
      source: "workspace",
    };
  }
  const archivedUrl = record?.autoArchivedChangeRequestUrl;
  if (archivedUrl) {
    return {
      url: archivedUrl,
      number: findPullRequestUrl(archivedUrl)?.number ?? null,
      title: null,
      state: "merged",
      source: "archive",
    };
  }
  const fromOutput = output ? findPullRequestUrl(output) : null;
  if (fromOutput) {
    return {
      url: fromOutput.url,
      number: fromOutput.number || null,
      title: null,
      state: null,
      source: "output",
    };
  }
  return null;
}

function capOutput(output: string | null | undefined): { text: string | null; truncated: boolean } {
  if (typeof output !== "string" || output.length === 0) return { text: null, truncated: false };
  if (output.length <= OUTPUT_MAX_CHARS) return { text: output, truncated: false };
  return { text: output.slice(0, OUTPUT_MAX_CHARS), truncated: true };
}

function toRunAgent(agentId: string | null, agent: PaseoAgent | undefined): RunAgent | null {
  if (agent) {
    return {
      id: agent.id,
      title: agent.title ?? null,
      status: agent.status,
      archivedAt: agent.archivedAt ?? null,
      known: true,
    };
  }
  if (!agentId) return null;
  return { id: agentId, title: null, status: null, archivedAt: null, known: false };
}

function toRunWorkspace(
  workspaceId: string | null,
  record: WorkspaceRecord | undefined,
): RunWorkspace | null {
  if (record) {
    return {
      id: record.workspaceId,
      name: record.title?.trim() || record.displayName?.trim() || null,
      branch: record.branch?.trim() || null,
      projectId: record.projectId ?? null,
      archivedAt: record.archivedAt ?? null,
      known: true,
    };
  }
  if (!workspaceId) return null;
  return { id: workspaceId, name: null, branch: null, projectId: null, archivedAt: null, known: false };
}

function toRunRow(
  schedule: PersistedSchedule,
  run: PersistedRun,
  agents: AgentIndex,
  workspaces: ReadonlyMap<string, WorkspaceRecord>,
  liveWorkspaces: WorkspaceIndex,
): RunRow {
  // The run record names the agent once the daemon created it; a run whose record was written
  // before that (or lost it) can still be joined back through the label on the agent.
  const agent =
    (run.agentId ? agents.byId.get(run.agentId) : undefined) ?? agents.byRunId.get(run.id);
  const agentId = run.agentId ?? agent?.id ?? null;
  // Heartbeat runs carry no workspace of their own; the targeted agent's workspace stands in.
  const workspaceId = run.workspaceId ?? agent?.workspaceId ?? null;
  const output = capOutput(run.output);
  const record = workspaceId ? workspaces.get(workspaceId) : undefined;
  const live = workspaceId ? liveWorkspaces.get(workspaceId) : undefined;
  return {
    id: run.id,
    scheduleId: schedule.id,
    scheduleName: schedule.name ?? null,
    targetType: schedule.target.type,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    status: run.status,
    output: output.text,
    outputTruncated: output.truncated,
    error: run.error ?? null,
    agent: toRunAgent(agentId, agent),
    workspace: toRunWorkspace(workspaceId, record),
    pullRequest: toPullRequest(live, record, output.text),
  };
}

function toScheduleSummary(schedule: PersistedSchedule): ScheduleSummary {
  const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
  return {
    id: schedule.id,
    name: schedule.name ?? null,
    targetType: schedule.target.type,
    status: schedule.status,
    cadence: describeCadence(schedule.cadence),
    nextRunAt: schedule.nextRunAt ?? null,
    lastRunAt: schedule.lastRunAt ?? null,
    maxRuns: schedule.maxRuns ?? null,
    runCount: schedule.runs.length,
    counts: countByStatus(schedule.runs),
    provider: config?.provider ?? null,
    cwd: config?.cwd ?? null,
    title: config?.title ?? null,
  };
}

export async function listRuns(
  input: RpcInput<typeof listScheduleRuns>,
  paseo: PaseoApi,
): Promise<RpcOutput<typeof listScheduleRuns>> {
  const limit = input.limit ?? DEFAULT_RUN_LIMIT;
  const includeHeartbeats = input.includeHeartbeats ?? false;

  const [schedules, workspaces, agents, liveWorkspaces] = await Promise.all([
    readSchedules(),
    readWorkspaceRegistry(),
    cachedAgentIndex(paseo),
    cachedWorkspaceIndex(paseo),
  ]);

  const visible = schedules.filter(
    (schedule) => includeHeartbeats || schedule.target.type !== "agent",
  );
  const runs: RunRow[] = [];
  for (const schedule of visible) {
    for (const run of schedule.runs) {
      runs.push(toRunRow(schedule, run, agents, workspaces, liveWorkspaces));
    }
  }
  runs.sort((left, right) => {
    const byStart = right.startedAt.localeCompare(left.startedAt);
    return byStart !== 0 ? byStart : left.id.localeCompare(right.id);
  });

  return {
    schedules: visible.map(toScheduleSummary),
    runs: runs.slice(0, limit),
    truncated: runs.length > limit,
    generatedAt: new Date().toISOString(),
  };
}
