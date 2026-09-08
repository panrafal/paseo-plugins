import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";

/**
 * Pure derivation of the dashboard from Paseo's workspace and agent directories. Nothing in
 * here touches React, React Native, or Node, so both runtimes and tests can import it.
 */

export const DASH_GROUPS = [
  "waiting",
  "unread",
  "working",
  "failing",
  "accepted",
  "idle",
  "closed",
] as const;

export type DashGroup = (typeof DASH_GROUPS)[number];

export const DASH_GROUP_LABELS: Record<DashGroup, string> = {
  waiting: "Waiting for you",
  unread: "Unread",
  working: "In progress",
  failing: "Failing",
  accepted: "Approved",
  idle: "Idle",
  closed: "Merged or closed",
};

export const DASH_GROUP_DESCRIPTIONS: Record<DashGroup, string> = {
  waiting: "An agent asked a question or needs a permission answered.",
  unread: "An agent finished with results you have not seen yet.",
  working: "An agent is working right now.",
  failing: "An agent errored, a check failed, or a reviewer requested changes.",
  accepted: "The pull request is approved and nothing is failing.",
  idle: "Everything is done and read.",
  closed: "The pull request was merged or closed.",
};

/** Lucide icon per group, drawn in the group header. */
export const DASH_GROUP_ICONS: Record<DashGroup, string> = {
  waiting: "CircleAlert",
  unread: "CircleDot",
  working: "LoaderCircle",
  failing: "CircleX",
  accepted: "ThumbsUp",
  idle: "Circle",
  closed: "GitMerge",
};

/** Quick actions live only on the two calm groups; everything else navigates. */
export function quickActionsFor(group: DashGroup): readonly DashQuickAction[] {
  if (group === "closed") return CLOSED_ACTIONS;
  if (group === "idle") return IDLE_ACTIONS;
  return NO_ACTIONS;
}

export type DashQuickAction = "archive" | "markUnread";
const NO_ACTIONS: readonly DashQuickAction[] = [];
const CLOSED_ACTIONS: readonly DashQuickAction[] = ["archive"];
const IDLE_ACTIONS: readonly DashQuickAction[] = ["markUnread", "archive"];

export const AGENT_ACTIVITIES = ["waiting", "unread", "working", "failing", "idle"] as const;

export type AgentActivity = (typeof AGENT_ACTIVITIES)[number];

export const AGENT_ACTIVITY_LABELS: Record<AgentActivity, string> = {
  waiting: "Waiting for your answer",
  unread: "Finished, not read yet",
  working: "Working",
  failing: "Failed",
  idle: "Idle",
};

/** Lucide icon per agent activity, drawn inside the agent pill. */
export const AGENT_ACTIVITY_ICONS: Record<AgentActivity, string> = {
  waiting: "CircleAlert",
  unread: "CircleDot",
  working: "LoaderCircle",
  failing: "CircleX",
  idle: "Check",
};

export interface DashAgent {
  id: string;
  /** Title Paseo shows for the agent, or the provider name when it has none. */
  title: string;
  /** Title cut down to fit a pill. */
  shortName: string;
  provider: string;
  model: string | null;
  activity: AgentActivity;
  /** True while the provider session is still starting; rendered as working. */
  starting: boolean;
  /** Epoch milliseconds of the latest activity Paseo reported for this agent. */
  lastActivityAt: number;
}

export type PullRequestState = "open" | "merged" | "closed";
export type PullRequestChecks = "passed" | "failed" | "running" | "none";
export type PullRequestReview = "approved" | "changes_requested" | "pending" | null;

export interface DashPullRequest {
  number: number | null;
  url: string;
  title: string;
  state: PullRequestState;
  isDraft: boolean;
  checks: PullRequestChecks;
  checksCompleted: number;
  checksTotal: number;
  review: PullRequestReview;
  /** Forge id (`github`, `gitlab`, ...); defaults to GitHub like the app does. */
  forge: string;
}

export interface DashWorkspace {
  id: string;
  projectId: string;
  projectName: string;
  projectRootPath: string;
  projectCustomIconRevision: string | null;
  name: string;
  kind: PaseoWorkspace["workspaceKind"];
  branch: string | null;
  labels: readonly string[];
  /** The daemon's own aggregate bucket; one input to `group`. */
  status: PaseoWorkspace["status"];
  archivingAt: string | null;
  hasUncommittedChanges: boolean | null;
  unpushedCommitCount: number | null;
  diffStat: { additions: number; deletions: number } | null;
  hasRunningServices: boolean;
  pullRequest: DashPullRequest | null;
  /** Root agents in this workspace, most important first. */
  agents: readonly DashAgent[];
  group: DashGroup;
  /** Epoch milliseconds of the latest activity across the workspace and its agents. */
  lastActivityAt: number;
  /** ISO timestamp of an active plugin-owned unread mark, or null. */
  unreadMarkedAt: string | null;
}

export interface DashGroupModel {
  group: DashGroup;
  workspaces: readonly DashWorkspace[];
}

export interface DashModel {
  /** Only non-empty groups, in `DASH_GROUPS` order. */
  groups: readonly DashGroupModel[];
  total: number;
}

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "Oh My Pi",
  cursor: "Cursor",
  gemini: "Gemini",
};

export function providerLabel(provider: string): string {
  const known = PROVIDER_LABELS[provider];
  if (known) return known;
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Agent";
}

const SHORT_NAME_MAX = 22;

export function shortenName(name: string, max: number = SHORT_NAME_MAX): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getParentAgentId(agent: Pick<PaseoAgent, "labels">): string | null {
  const value = agent.labels?.[PARENT_AGENT_ID_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * A root agent owns a workspace track. Subagents that run in their parent's workspace only
 * contribute activity; a subagent placed in another workspace is that workspace's root. An
 * unknown parent (archived, on another daemon) leaves the agent visible rather than hidden.
 */
export function isWorkspaceRootAgent(
  agent: Pick<PaseoAgent, "labels" | "workspaceId">,
  agentsById: ReadonlyMap<string, Pick<PaseoAgent, "workspaceId">>,
): boolean {
  const parentId = getParentAgentId(agent);
  if (!parentId) return true;
  const parent = agentsById.get(parentId);
  if (!parent) return true;
  return Boolean(agent.workspaceId && parent.workspaceId && agent.workspaceId !== parent.workspaceId);
}

export function deriveAgentActivity(
  agent: Pick<
    PaseoAgent,
    "status" | "pendingPermissions" | "requiresAttention" | "attentionReason"
  >,
): AgentActivity {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission") {
    return "waiting";
  }
  if (agent.status === "error" || agent.attentionReason === "error") return "failing";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.requiresAttention) return "unread";
  return "idle";
}

const AGENT_ACTIVITY_RANK: Record<AgentActivity, number> = {
  waiting: 0,
  unread: 1,
  working: 2,
  failing: 3,
  idle: 4,
};

export function compareAgents(a: DashAgent, b: DashAgent): number {
  const rank = AGENT_ACTIVITY_RANK[a.activity] - AGENT_ACTIVITY_RANK[b.activity];
  if (rank !== 0) return rank;
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  return a.id.localeCompare(b.id);
}

export function toDashAgent(agent: PaseoAgent): DashAgent {
  const title = agent.title?.trim() || providerLabel(agent.provider);
  return {
    id: agent.id,
    title,
    shortName: shortenName(title),
    provider: agent.provider,
    model: agent.model ?? null,
    activity: deriveAgentActivity(agent),
    starting: agent.status === "initializing",
    lastActivityAt: Math.max(parseTime(agent.updatedAt), parseTime(agent.attentionTimestamp)),
  };
}

function parsePullRequestNumber(url: string): number | null {
  const match = /\/(?:pull|pulls|merge_requests)\/(\d+)(?:\/|$)/.exec(safePathname(url));
  if (!match) return null;
  const number = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(number) ? number : null;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

type WorkspacePullRequest = NonNullable<NonNullable<PaseoWorkspace["githubRuntime"]>["pullRequest"]>;

function summarizeChecks(pullRequest: WorkspacePullRequest): {
  checks: PullRequestChecks;
  completed: number;
  total: number;
} {
  const checks = pullRequest.checks ?? [];
  if (checks.length > 0) {
    let completed = 0;
    let failed = false;
    for (const check of checks) {
      if (check.status === "failure" || check.status === "cancelled") failed = true;
      if (check.status !== "pending") completed += 1;
    }
    if (failed) return { checks: "failed", completed: checks.length, total: checks.length };
    if (completed === checks.length) return { checks: "passed", completed, total: checks.length };
    return { checks: "running", completed, total: checks.length };
  }
  switch (pullRequest.checksStatus) {
    case "success":
      return { checks: "passed", completed: 1, total: 1 };
    case "failure":
      return { checks: "failed", completed: 1, total: 1 };
    case "pending":
      return { checks: "running", completed: 0, total: 1 };
    default:
      return { checks: "none", completed: 0, total: 0 };
  }
}

export function toDashPullRequest(workspace: PaseoWorkspace): DashPullRequest | null {
  const pullRequest = workspace.githubRuntime?.pullRequest;
  if (!pullRequest?.url) return null;
  const rawState = pullRequest.state.toLowerCase();
  let state: PullRequestState;
  if (pullRequest.isMerged || rawState === "merged") state = "merged";
  else if (rawState === "open") state = "open";
  else state = "closed";
  const summary = summarizeChecks(pullRequest);
  return {
    number: pullRequest.number ?? parsePullRequestNumber(pullRequest.url),
    url: pullRequest.url,
    title: pullRequest.title,
    state,
    isDraft: pullRequest.isDraft ?? false,
    checks: summary.checks,
    checksCompleted: summary.completed,
    checksTotal: summary.total,
    review: pullRequest.reviewDecision ?? null,
    forge: workspace.forge && workspace.forge.length > 0 ? workspace.forge : "github",
  };
}

/**
 * A plugin-owned unread mark stays until the user opens the workspace from the dash, or until
 * the workspace produces newer activity, at which point the real state supersedes it. While
 * active it ranks like agent output the user has not read: above pull-request state, below
 * live agent activity (see `deriveWorkspaceGroup`).
 */
export function isUnreadMarkActive(
  markedAt: string | undefined,
  workspaceActivityAt: number,
): boolean {
  if (!markedAt) return false;
  const marked = parseTime(markedAt);
  return marked > 0 && marked >= workspaceActivityAt;
}

export function deriveWorkspaceGroup(input: {
  status: PaseoWorkspace["status"];
  agents: readonly Pick<DashAgent, "activity">[];
  pullRequest: DashPullRequest | null;
  unreadMarked: boolean;
}): DashGroup {
  const { status, agents, pullRequest, unreadMarked } = input;
  const has = (activity: AgentActivity) => agents.some((agent) => agent.activity === activity);

  if (status === "needs_input" || has("waiting")) return "waiting";
  if (status === "attention" || has("unread")) return "unread";
  if (status === "running" || has("working")) return "working";
  if (status === "failed" || has("failing")) return "failing";
  // A manual mark stands in for unseen agent output, so it outranks what the pull request says
  // but never hides live agent activity.
  if (unreadMarked) return "unread";
  if (pullRequest?.state === "open") {
    if (pullRequest.checks === "failed" || pullRequest.review === "changes_requested") {
      return "failing";
    }
    if (pullRequest.review === "approved") return "accepted";
    return "idle";
  }
  if (pullRequest) return "closed";
  return "idle";
}

export function compareWorkspaces(a: DashWorkspace, b: DashWorkspace): number {
  if (a.lastActivityAt !== b.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
  const project = a.projectName.localeCompare(b.projectName);
  if (project !== 0) return project;
  const name = a.name.localeCompare(b.name);
  if (name !== 0) return name;
  return a.id.localeCompare(b.id);
}

export function buildDashModel(input: {
  workspaces: Iterable<PaseoWorkspace>;
  agents: Iterable<PaseoAgent>;
  unreadMarks: Readonly<Record<string, string>>;
}): DashModel {
  const agentsById = new Map<string, PaseoAgent>();
  for (const agent of input.agents) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    agentsById.set(agent.id, agent);
  }

  const agentsByWorkspace = new Map<string, DashAgent[]>();
  for (const agent of agentsById.values()) {
    if (!agent.workspaceId || !isWorkspaceRootAgent(agent, agentsById)) continue;
    const list = agentsByWorkspace.get(agent.workspaceId) ?? [];
    list.push(toDashAgent(agent));
    agentsByWorkspace.set(agent.workspaceId, list);
  }

  const byGroup = new Map<DashGroup, DashWorkspace[]>();
  let total = 0;
  for (const workspace of input.workspaces) {
    const agents = (agentsByWorkspace.get(workspace.id) ?? []).sort(compareAgents);
    const pullRequest = toDashPullRequest(workspace);
    const activityAt = Math.max(
      parseTime(workspace.activityAt),
      parseTime(workspace.statusEnteredAt),
      ...agents.map((agent) => agent.lastActivityAt),
    );
    const mark = input.unreadMarks[workspace.id];
    const unreadMarked = isUnreadMarkActive(mark, activityAt);
    const group = deriveWorkspaceGroup({
      status: workspace.status,
      agents,
      pullRequest,
      unreadMarked,
    });
    const entry: DashWorkspace = {
      id: workspace.id,
      projectId: workspace.projectId,
      projectName: workspace.projectDisplayName,
      projectRootPath: workspace.projectRootPath,
      projectCustomIconRevision: workspace.projectCustomIconRevision ?? null,
      name: workspace.name,
      kind: workspace.workspaceKind,
      branch: normalizeBranch(workspace.gitRuntime?.currentBranch),
      labels: workspace.labels ?? [],
      status: workspace.status,
      archivingAt: workspace.archivingAt ?? null,
      hasUncommittedChanges: workspace.gitRuntime?.isDirty ?? null,
      unpushedCommitCount: workspace.gitRuntime?.aheadOfOrigin ?? null,
      diffStat: workspace.diffStat ?? null,
      hasRunningServices: (workspace.scripts ?? []).some(
        (script) => script.lifecycle === "running",
      ),
      pullRequest,
      agents,
      group,
      lastActivityAt: activityAt,
      unreadMarkedAt: unreadMarked && mark ? mark : null,
    };
    const list = byGroup.get(group) ?? [];
    list.push(entry);
    byGroup.set(group, list);
    total += 1;
  }

  const groups: DashGroupModel[] = [];
  for (const group of DASH_GROUPS) {
    const workspaces = byGroup.get(group);
    if (!workspaces || workspaces.length === 0) continue;
    workspaces.sort(compareWorkspaces);
    groups.push({ group, workspaces });
  }
  return { groups, total };
}

function normalizeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  return trimmed ? trimmed : null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Compact relative time the way the sidebar shows it: `now`, `5m`, `2h`, `3d`, `Jan 15`. */
export function formatTimeAgo(timestampMs: number, nowMs: number): string {
  if (!timestampMs) return "";
  const elapsed = nowMs - timestampMs;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
  const date = new Date(timestampMs);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Initial drawn in the generated project icon: last path segment, first character. */
export function projectInitial(displayName: string): string {
  const segments = displayName.trim().split("/").filter(Boolean);
  const label = segments[segments.length - 1] ?? displayName.trim();
  return label.charAt(0).toUpperCase();
}
