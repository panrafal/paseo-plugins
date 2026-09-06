import type { RunPullRequest, RunRow, RunStatus, ScheduleSummary, StatusCounts } from "./contracts";

/**
 * Pure helpers shared by the server (which describes cadences) and the client (which filters
 * and formats). Nothing here touches React, React Native, or Node.
 */

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

/** Lucide icon per run status. */
export const RUN_STATUS_ICONS: Record<RunStatus, string> = {
  running: "LoaderCircle",
  succeeded: "CircleCheck",
  failed: "CircleX",
};

export type ArchivedMode = "all" | "hide" | "only";

export const ARCHIVED_MODES = ["all", "hide", "only"] as const satisfies readonly ArchivedMode[];

export const ARCHIVED_MODE_LABELS: Record<ArchivedMode, string> = {
  all: "All",
  hide: "Hide archived",
  only: "Only archived",
};

export interface RunFilters {
  /** Empty means every schedule. */
  scheduleIds: ReadonlySet<string>;
  /** Empty means every status. */
  statuses: ReadonlySet<RunStatus>;
  archived: ArchivedMode;
  query: string;
}

export const EMPTY_FILTERS: RunFilters = {
  scheduleIds: new Set(),
  statuses: new Set(),
  archived: "all",
  query: "",
};

export function scheduleLabel(schedule: {
  id: string;
  name: string | null;
  title?: string | null;
}): string {
  const name = schedule.name?.trim();
  if (name) return name;
  const title = schedule.title?.trim();
  if (title) return title;
  return `Schedule ${schedule.id}`;
}

export function runScheduleLabel(run: Pick<RunRow, "scheduleId" | "scheduleName">): string {
  return scheduleLabel({ id: run.scheduleId, name: run.scheduleName });
}

/** A run counts as archived once the agent or the workspace it produced was archived. */
export function isRunArchived(run: Pick<RunRow, "agent" | "workspace">): boolean {
  return Boolean(run.agent?.archivedAt || run.workspace?.archivedAt);
}

export function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The daemon prefixes a run's recorded output with a Markdown rule (`\n\n---\n\n`) when it
 * joins the agent's final message onto earlier text. It carries no information, so it goes.
 */
export function cleanOutput(text: string): string {
  return text.replace(/^\s*---\s*\n/, "").trim();
}

const PREVIEW_MAX = 240;

/** Markdown syntax that would only be noise in a three-line preview: links become their text,
 * emphasis and code markers, heading hashes, and list bullets go. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1");
}

/** One paragraph's worth of the output, Markdown stripped and whitespace collapsed, for the
 * collapsed card. */
export function previewText(text: string, max: number = PREVIEW_MAX): string {
  const collapsed = stripMarkdown(cleanOutput(text)).replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

const haystacks = new WeakMap<RunRow, string>();

/** Everything a keyword can match, lowercased once per row object. */
function runHaystack(run: RunRow): string {
  const cached = haystacks.get(run);
  if (cached !== undefined) return cached;
  const haystack = [
    run.output,
    run.error,
    runScheduleLabel(run),
    run.workspace?.name,
    run.workspace?.branch,
    run.agent?.title,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .toLowerCase();
  haystacks.set(run, haystack);
  return haystack;
}

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Case-insensitive; every word of the query must appear somewhere in the row. */
export function filterRuns(runs: readonly RunRow[], filters: RunFilters): RunRow[] {
  const words = queryWords(filters.query);
  return runs.filter((run) => {
    if (filters.scheduleIds.size > 0 && !filters.scheduleIds.has(run.scheduleId)) return false;
    if (filters.statuses.size > 0 && !filters.statuses.has(run.status)) return false;
    if (filters.archived !== "all") {
      const archived = isRunArchived(run);
      if (filters.archived === "hide" && archived) return false;
      if (filters.archived === "only" && !archived) return false;
    }
    if (words.length === 0) return true;
    const haystack = runHaystack(run);
    return words.every((word) => haystack.includes(word));
  });
}

export function countByStatus(runs: Iterable<Pick<RunRow, "status">>): StatusCounts {
  const counts: StatusCounts = { running: 0, succeeded: 0, failed: 0 };
  for (const run of runs) counts[run.status] += 1;
  return counts;
}

export function countBySchedule(runs: Iterable<Pick<RunRow, "scheduleId">>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.scheduleId, (counts.get(run.scheduleId) ?? 0) + 1);
  return counts;
}

export function compareSchedules(a: ScheduleSummary, b: ScheduleSummary): number {
  const label = scheduleLabel(a).localeCompare(scheduleLabel(b));
  if (label !== 0) return label;
  return a.id.localeCompare(b.id);
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** `<1s`, `42s`, `4m 5s`, `1h 3m`, `2d 4h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < SECOND_MS) return "<1s";
  const totalSeconds = Math.round(ms / SECOND_MS);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

/** Elapsed time of a run: to its end, or to `nowMs` while it is still running. */
export function runDuration(run: Pick<RunRow, "startedAt" | "endedAt">, nowMs: number): string {
  const started = parseTime(run.startedAt);
  if (!started) return "";
  const ended = run.endedAt ? parseTime(run.endedAt) : nowMs;
  return formatDuration(ended - started);
}

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

export type ScheduleCadence =
  | { type: "cron"; expression: string; timezone?: string | null }
  | { type: "every"; everyMs: number };

/** `0 9 * * 1 (Europe/Warsaw)` for cron schedules, `every 30m` for interval ones. */
export function describeCadence(cadence: ScheduleCadence): string {
  if (cadence.type === "cron") {
    return cadence.timezone ? `${cadence.expression} (${cadence.timezone})` : cadence.expression;
  }
  return `every ${formatDuration(cadence.everyMs).replace(/ 0[smh]$/, "")}`;
}

const PULL_REQUEST_URL = /https?:\/\/[^\s<>()[\]"'`]+?\/(?:pull|pulls|merge_requests)\/(\d+)(?=[^\w/]|$)/;

/** The first pull request URL in a text, with its number, or null. */
export function findPullRequestUrl(text: string): { url: string; number: number } | null {
  const match = PULL_REQUEST_URL.exec(text);
  if (!match) return null;
  const number = Number.parseInt(match[1] ?? "", 10);
  return { url: match[0], number: Number.isFinite(number) ? number : 0 };
}

export function pullRequestNumber(url: string): number | null {
  const found = findPullRequestUrl(url);
  return found && found.number > 0 ? found.number : null;
}

/** `#193`, `!12` for GitLab, or `PR` when the number is unknown. */
export function pullRequestLabel(pullRequest: Pick<RunPullRequest, "url" | "number">): string {
  const number = pullRequest.number ?? pullRequestNumber(pullRequest.url);
  if (number === null) return "PR";
  return `${/\/merge_requests\//.test(pullRequest.url) ? "!" : "#"}${number}`;
}

/** `3 runs · 2 succeeded · 1 failed · 1 running`; zero counts are left out except the two that matter. */
export function describeCounts(total: number, counts: StatusCounts): string {
  const parts = [`${total} ${total === 1 ? "run" : "runs"}`];
  parts.push(`${counts.succeeded} succeeded`, `${counts.failed} failed`);
  if (counts.running > 0) parts.push(`${counts.running} running`);
  return parts.join(" · ");
}
