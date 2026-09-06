import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";
import type {
  AgentStatus,
  AgentSummary,
  ProjectSummary,
  WorkspaceSummary,
  listHistory,
} from "../shared/contracts";
import { AGENT_STATUSES } from "../shared/contracts";
import { paseoHome } from "./paseo-home";
import { resolveTranscripts } from "./transcripts";

/**
 * The plugin SDK lists only live workspaces and cannot see archived ones, so the census comes
 * from the daemon's own records on disk: the workspace and project registries under
 * `$PASEO_HOME/projects` and one JSON file per agent under `$PASEO_HOME/agents`. Files are
 * re-parsed only when their size or mtime moves.
 *
 * Agent records carry provider credentials in `persistence.metadata`. The record schema below
 * does not declare that field, so zod strips it at parse time and it never reaches a summary.
 * Raw records are never logged.
 */

const LOG_PREFIX = "[agents-history]";
/** How many agents resolve their transcript files at once. */
const RESOLVE_CONCURRENCY = 16;

const WorkspaceRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().nullable().optional(),
  cwd: z.string(),
  kind: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  pinnedAt: z.string().nullable().optional(),
  autoArchivedChangeRequestUrl: z.string().nullable().optional(),
  labels: z.array(z.string()).nullable().optional(),
});
type WorkspaceRecord = z.output<typeof WorkspaceRecordSchema>;

const ProjectRecordSchema = z.object({
  projectId: z.string(),
  rootPath: z.string(),
  kind: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  customName: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
});
type ProjectRecord = z.output<typeof ProjectRecordSchema>;

const AgentRecordSchema = z.object({
  id: z.string(),
  provider: z.string(),
  cwd: z.string(),
  workspaceId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
  lastActivityAt: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  lastStatus: z.string().nullable().optional(),
  archivedAt: z.string().nullable().optional(),
  internal: z.boolean().optional(),
  config: z.object({ model: z.string().nullable().optional() }).optional(),
  runtimeInfo: z.object({ model: z.string().nullable().optional() }).optional(),
  persistence: z
    .object({
      provider: z.string().optional(),
      sessionId: z.string().nullable().optional(),
      nativeHandle: z.string().nullable().optional(),
      // `metadata` is deliberately not declared: it holds credentials and is stripped here.
    })
    .optional(),
});
export type AgentRecord = z.output<typeof AgentRecordSchema>;

interface CachedFile<Value> {
  mtimeMs: number;
  size: number;
  value: Value;
}

let workspaceFile: CachedFile<WorkspaceRecord[]> | null = null;
let projectFile: CachedFile<ProjectRecord[]> | null = null;
const agentFiles = new Map<string, CachedFile<AgentRecord | null>>();

export function clearCensusCaches(): void {
  workspaceFile = null;
  projectFile = null;
  agentFiles.clear();
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readCachedJson<Value>(
  path: string,
  cached: CachedFile<Value> | null | undefined,
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

function parseRecordArray<Schema extends z.ZodType>(
  schema: Schema,
  fileName: string,
): (raw: unknown) => z.output<Schema>[] {
  return (raw) => {
    if (!Array.isArray(raw)) {
      console.warn(`${LOG_PREFIX} ${fileName} is not an array; treating as empty`);
      return [];
    }
    const records: z.output<Schema>[] = [];
    for (const candidate of raw) {
      const parsed = schema.safeParse(candidate);
      if (parsed.success) records.push(parsed.data);
      else console.warn(`${LOG_PREFIX} ignoring invalid record in ${fileName}`);
    }
    return records;
  };
}

async function readWorkspaces(): Promise<WorkspaceRecord[]> {
  const path = join(paseoHome(), "projects", "workspaces.json");
  try {
    workspaceFile = await readCachedJson(
      path,
      workspaceFile,
      parseRecordArray(WorkspaceRecordSchema, "workspaces.json"),
    );
  } catch (error) {
    if (!workspaceFile) throw error;
    console.warn(`${LOG_PREFIX} could not re-read workspaces.json; keeping the last copy`);
  }
  return workspaceFile?.value ?? [];
}

async function readProjects(): Promise<ProjectRecord[]> {
  const path = join(paseoHome(), "projects", "projects.json");
  try {
    projectFile = await readCachedJson(
      path,
      projectFile,
      parseRecordArray(ProjectRecordSchema, "projects.json"),
    );
  } catch (error) {
    if (!projectFile) throw error;
    console.warn(`${LOG_PREFIX} could not re-read projects.json; keeping the last copy`);
  }
  return projectFile?.value ?? [];
}

function parseAgent(fileName: string): (raw: unknown) => AgentRecord | null {
  return (raw) => {
    const parsed = AgentRecordSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    console.warn(`${LOG_PREFIX} ignoring invalid agent record ${fileName}`);
    return null;
  };
}

async function listDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** Every stored agent record, archived ones included, internal ones excluded. */
export async function loadAgentRecords(): Promise<AgentRecord[]> {
  const root = join(paseoHome(), "agents");
  const seen = new Set<string>();
  const records: AgentRecord[] = [];
  for (const directory of await listDirectory(root)) {
    if (!directory.isDirectory()) continue;
    const directoryPath = join(root, directory.name);
    for (const entry of await listDirectory(directoryPath)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(directoryPath, entry.name);
      seen.add(path);
      let cached: CachedFile<AgentRecord | null> | null;
      try {
        cached = await readCachedJson(path, agentFiles.get(path), parseAgent(entry.name));
      } catch {
        console.warn(`${LOG_PREFIX} could not read agent record ${entry.name}`);
        cached = agentFiles.get(path) ?? null;
      }
      if (!cached) {
        agentFiles.delete(path);
        continue;
      }
      agentFiles.set(path, cached);
      if (cached.value && !cached.value.internal) records.push(cached.value);
    }
  }
  for (const path of [...agentFiles.keys()]) {
    if (!seen.has(path)) agentFiles.delete(path);
  }
  return records;
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd).replace(/[\\/]+$/, "");
}

function normalizeStatus(value: string | null | undefined): AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(value ?? "")
    ? (value as AgentStatus)
    : "unknown";
}

function toWorkspaceSummary(record: WorkspaceRecord): WorkspaceSummary {
  return {
    workspaceId: record.workspaceId,
    projectId: record.projectId ?? null,
    cwd: record.cwd,
    kind: record.kind ?? null,
    displayName: record.displayName ?? null,
    title: record.title ?? null,
    branch: record.branch ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    archivedAt: record.archivedAt ?? null,
    pinnedAt: record.pinnedAt ?? null,
    autoArchivedChangeRequestUrl: record.autoArchivedChangeRequestUrl ?? null,
    labels: record.labels ?? [],
  };
}

function toProjectSummary(record: ProjectRecord): ProjectSummary {
  return {
    projectId: record.projectId,
    displayName: record.displayName ?? null,
    customName: record.customName ?? null,
    rootPath: record.rootPath,
    kind: record.kind ?? null,
    archivedAt: record.archivedAt ?? null,
  };
}

async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as Item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function buildCensus(): Promise<RpcOutput<typeof listHistory>> {
  const [workspaceRecords, projectRecords, agentRecords] = await Promise.all([
    readWorkspaces(),
    readProjects(),
    loadAgentRecords(),
  ]);

  const byId = new Map<string, WorkspaceRecord>();
  const byCwd = new Map<string, WorkspaceRecord>();
  // Archived first so a live workspace sharing the directory wins the cwd fallback.
  const ordered = [...workspaceRecords].sort(
    (a, b) => Number(Boolean(b.archivedAt)) - Number(Boolean(a.archivedAt)),
  );
  for (const record of ordered) {
    byId.set(record.workspaceId, record);
    byCwd.set(normalizeCwd(record.cwd), record);
  }

  const agents = await mapWithConcurrency(agentRecords, RESOLVE_CONCURRENCY, async (record) => {
    const workspaceId =
      record.workspaceId && byId.has(record.workspaceId)
        ? record.workspaceId
        : (byCwd.get(normalizeCwd(record.cwd))?.workspaceId ?? null);
    const resolution = await resolveTranscripts(record);
    const summary: AgentSummary = {
      id: record.id,
      workspaceId,
      provider: record.provider,
      title: record.title ?? null,
      status: normalizeStatus(record.lastStatus),
      archivedAt: record.archivedAt ?? null,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt ?? record.updatedAt ?? null,
      model: record.config?.model ?? record.runtimeInfo?.model ?? null,
      transcript: {
        searchable: resolution.files.length > 0,
        ...(resolution.reason ? { reason: resolution.reason } : {}),
        fileCount: resolution.files.length,
      },
    };
    return summary;
  });

  return {
    projects: projectRecords.map(toProjectSummary),
    workspaces: workspaceRecords.map(toWorkspaceSummary),
    agents,
    generatedAt: new Date().toISOString(),
  };
}
