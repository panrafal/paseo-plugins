import type {
  AgentMatch,
  AgentStatus,
  AgentSummary,
  HistoryList,
  ProjectSummary,
  SnippetRole,
  WorkspaceSummary,
} from "./contracts";

/**
 * Pure view-model helpers shared by the surface and its rows: joining the census into workspace
 * rows, the filter model, sorting, and the small formatting functions. No React, React Native,
 * or Node imports belong here.
 */

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  initializing: "Starting",
  idle: "Idle",
  running: "Running",
  error: "Error",
  closed: "Closed",
  unknown: "Unknown",
};

export const SNIPPET_ROLE_LABELS: Record<SnippetRole, string> = {
  user: "you",
  assistant: "agent",
  tool: "tool",
  other: "meta",
};

export const ARCHIVED_MODES = ["all", "active", "archived"] as const;
export type ArchivedMode = (typeof ARCHIVED_MODES)[number];
export const ARCHIVED_MODE_LABELS: Record<ArchivedMode, string> = {
  all: "All",
  active: "Active only",
  archived: "Archived only",
};

export const PERIOD_MODES = ["24h", "7d", "30d", "90d", "all"] as const;
export type PeriodMode = (typeof PERIOD_MODES)[number];
export const PERIOD_MODE_LABELS: Record<PeriodMode, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "Any time",
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const PERIOD_WINDOW_MS: Record<PeriodMode, number | null> = {
  "24h": DAY_MS,
  "7d": WEEK_MS,
  "30d": 30 * DAY_MS,
  "90d": 90 * DAY_MS,
  all: null,
};

export interface HistoryFilters {
  query: string;
  archived: ArchivedMode;
  /** Empty means every provider. */
  providers: ReadonlySet<string>;
  /** Empty means every project. */
  projectIds: ReadonlySet<string>;
  /** Empty means any label; otherwise the workspace needs at least one of them. */
  labels: ReadonlySet<string>;
  period: PeriodMode;
  regex: boolean;
  caseSensitive: boolean;
}

export const EMPTY_FILTERS: HistoryFilters = {
  query: "",
  archived: "all",
  providers: new Set(),
  projectIds: new Set(),
  labels: new Set(),
  period: "all",
  regex: false,
  caseSensitive: false,
};

/** Prefix of the id given to the synthetic row that holds agents without a workspace record. */
export const ORPHAN_WORKSPACE_PREFIX = "orphan:";

export interface HistoryWorkspace {
  id: string;
  workspace: WorkspaceSummary;
  project: ProjectSummary | null;
  agents: AgentSummary[];
  /** The workspace or its project is archived. */
  archived: boolean;
  /** True for the placeholder row grouping agents whose workspace record is gone. */
  synthetic: boolean;
  lastActivityMs: number;
}

export function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function workspaceLabel(workspace: WorkspaceSummary): string {
  return workspace.displayName?.trim() || workspace.title?.trim() || baseName(workspace.cwd);
}

export function projectLabel(project: ProjectSummary): string {
  return project.customName?.trim() || project.displayName?.trim() || baseName(project.rootPath);
}

export function agentLabel(agent: AgentSummary): string {
  return agent.title?.trim() || "untitled agent";
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

function compareByActivity(a: HistoryWorkspace, b: HistoryWorkspace): number {
  if (a.lastActivityMs !== b.lastActivityMs) return b.lastActivityMs - a.lastActivityMs;
  return a.id.localeCompare(b.id);
}

function compareAgents(a: AgentSummary, b: AgentSummary): number {
  const activity = parseTime(b.lastActivityAt) - parseTime(a.lastActivityAt);
  if (activity !== 0) return activity;
  return parseTime(b.createdAt) - parseTime(a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Joins the census into one row per workspace, newest activity first. Agents whose workspace
 * record no longer exists are grouped by directory under synthetic rows so they stay reachable.
 */
export function buildWorkspaces(list: HistoryList): HistoryWorkspace[] {
  const projects = new Map(list.projects.map((project) => [project.projectId, project]));
  const rows = new Map<string, HistoryWorkspace>();
  for (const workspace of list.workspaces) {
    const project = workspace.projectId ? (projects.get(workspace.projectId) ?? null) : null;
    rows.set(workspace.workspaceId, {
      id: workspace.workspaceId,
      workspace,
      project,
      agents: [],
      archived: Boolean(workspace.archivedAt) || Boolean(project?.archivedAt),
      synthetic: false,
      lastActivityMs: Math.max(parseTime(workspace.updatedAt), parseTime(workspace.createdAt)),
    });
  }
  for (const agent of list.agents) {
    const row = agent.workspaceId ? rows.get(agent.workspaceId) : undefined;
    if (row) {
      row.agents.push(agent);
      continue;
    }
    const orphanId = `${ORPHAN_WORKSPACE_PREFIX}${agent.workspaceId ?? agent.id}`;
    let orphan = rows.get(orphanId);
    if (!orphan) {
      orphan = {
        id: orphanId,
        workspace: {
          workspaceId: orphanId,
          projectId: null,
          cwd: "",
          kind: null,
          displayName: "Workspace record missing",
          title: null,
          branch: null,
          createdAt: agent.createdAt,
          updatedAt: agent.lastActivityAt,
          archivedAt: agent.archivedAt,
          pinnedAt: null,
          autoArchivedChangeRequestUrl: null,
          labels: [],
        },
        project: null,
        agents: [],
        archived: Boolean(agent.archivedAt),
        synthetic: true,
        lastActivityMs: 0,
      };
      rows.set(orphanId, orphan);
    }
    orphan.agents.push(agent);
  }
  const result = [...rows.values()];
  for (const row of result) {
    row.agents.sort(compareAgents);
    for (const agent of row.agents) {
      row.lastActivityMs = Math.max(
        row.lastActivityMs,
        parseTime(agent.lastActivityAt),
        parseTime(agent.createdAt),
      );
    }
  }
  return result.sort(compareByActivity);
}

export interface FilterContext {
  nowMs: number;
  /** Agent id → grep result; `null` while no transcript search has answered yet. */
  matches: ReadonlyMap<string, AgentMatch> | null;
}

/** Applies every filter except the search text. */
export function passesStaticFilters(
  row: HistoryWorkspace,
  filters: HistoryFilters,
  nowMs: number,
): boolean {
  if (filters.archived === "active" && row.archived) return false;
  if (filters.archived === "archived" && !row.archived) return false;
  if (filters.projectIds.size > 0) {
    if (!row.project || !filters.projectIds.has(row.project.projectId)) return false;
  }
  if (filters.labels.size > 0) {
    if (!row.workspace.labels.some((label) => filters.labels.has(label))) return false;
  }
  const window = PERIOD_WINDOW_MS[filters.period];
  if (window !== null && row.lastActivityMs < nowMs - window) return false;
  if (filters.providers.size > 0) {
    if (!row.agents.some((agent) => filters.providers.has(agent.provider))) return false;
  }
  return true;
}

/** Agents of a row that the provider filter keeps; every agent when no provider is chosen. */
export function visibleAgents(row: HistoryWorkspace, filters: HistoryFilters): AgentSummary[] {
  if (filters.providers.size === 0) return row.agents;
  return row.agents.filter((agent) => filters.providers.has(agent.provider));
}

export type QueryMatcher = (text: string) => boolean;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A predicate mirroring the grep flags so metadata and transcript matches agree. */
export function buildQueryMatcher(filters: HistoryFilters): QueryMatcher | null {
  const query = filters.query;
  if (query.trim().length === 0) return null;
  const flags = filters.caseSensitive ? "" : "i";
  try {
    const pattern = new RegExp(filters.regex ? query : escapeRegExp(query), flags);
    return (text) => pattern.test(text);
  } catch {
    const needle = filters.caseSensitive ? query : query.toLowerCase();
    return (text) => (filters.caseSensitive ? text : text.toLowerCase()).includes(needle);
  }
}

const metadataCache = new WeakMap<HistoryWorkspace, string[]>();

function metadataFields(row: HistoryWorkspace): string[] {
  const cached = metadataCache.get(row);
  if (cached) return cached;
  const fields = [
    row.workspace.displayName ?? "",
    row.workspace.title ?? "",
    row.workspace.branch ?? "",
    row.workspace.cwd,
    row.project ? projectLabel(row.project) : "",
    ...row.workspace.labels,
    ...row.agents.map((agent) => agent.title ?? ""),
  ].filter((field) => field.length > 0);
  metadataCache.set(row, fields);
  return fields;
}

export function matchesMetadata(row: HistoryWorkspace, matcher: QueryMatcher): boolean {
  return metadataFields(row).some(matcher);
}

/**
 * Rows to show: the static filters always apply; with a search text, a row also needs a metadata
 * match or a transcript hit on one of its visible agents.
 */
export function filterWorkspaces(
  rows: readonly HistoryWorkspace[],
  filters: HistoryFilters,
  context: FilterContext,
): HistoryWorkspace[] {
  const matcher = buildQueryMatcher(filters);
  return rows.filter((row) => {
    if (!passesStaticFilters(row, filters, context.nowMs)) return false;
    if (!matcher) return true;
    if (matchesMetadata(row, matcher)) return true;
    if (!context.matches) return false;
    return visibleAgents(row, filters).some((agent) => context.matches?.has(agent.id));
  });
}

export function countByProvider(rows: readonly HistoryWorkspace[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const agent of row.agents) counts.set(agent.provider, (counts.get(agent.provider) ?? 0) + 1);
  }
  return counts;
}

export function countByProject(rows: readonly HistoryWorkspace[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.project) continue;
    counts.set(row.project.projectId, (counts.get(row.project.projectId) ?? 0) + 1);
  }
  return counts;
}

export function countByLabel(rows: readonly HistoryWorkspace[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const label of row.workspace.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

export function formatTimeAgo(timestampMs: number, nowMs: number): string {
  if (!timestampMs) return "";
  const elapsed = nowMs - timestampMs;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  const date = new Date(timestampMs);
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(nowMs).getFullYear()
    ? label
    : `${label} ${date.getFullYear()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  kilo: "Kilo",
  copilot: "Copilot",
  gemini: "Gemini",
  opencode: "OpenCode",
  omp: "OMP",
  pi: "Pi",
};

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
