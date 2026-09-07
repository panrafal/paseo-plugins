import { addMetrics, emptyMetrics, type Bucket } from "./schema";
import { aggregate, chartGroups, DISPLAY_METRICS, encodeCsv, METRICS, type DisplayMetric, type SessionRow } from "./model";

export type TableGrouping = "sessions" | "provider" | "project" | "workspace" | "label" | "model" | "effort" | "day" | "week" | "month";
export const TABLE_GROUPINGS: { id: TableGrouping; label: string }[] = [
  { id: "sessions", label: "Sessions" }, { id: "provider", label: "Provider" },
  { id: "project", label: "Project" }, { id: "workspace", label: "Workspace" },
  { id: "label", label: "Label" },
  { id: "model", label: "Model" }, { id: "effort", label: "Effort" },
  { id: "day", label: "Day" }, { id: "week", label: "Week (Monday)" }, { id: "month", label: "Month" },
];
export type GroupSortKey = "title" | DisplayMetric;
export interface TableGroup {
  id: string;
  label: string;
  rows: SessionRow[];
  lifetimeMetrics: boolean;
  values: Record<DisplayMetric, ReturnType<typeof aggregate>>;
}
export function groupSessionRows(rows: SessionRow[], grouping: Exclude<TableGrouping, "sessions">): TableGroup[] {
  const groups = new Map<string, { label: string; rows: SessionRow[] }>();
  function put(id: string, label: string, row: SessionRow) {
    let group = groups.get(id);
    if (!group) { group = { label, rows: [] }; groups.set(id, group); }
    group.rows.push(row);
  }
  if (["day", "week", "month", "model"].includes(grouping)) {
    for (const group of chartGroups(rows, grouping as "day" | "week" | "month" | "model")) {
      for (const row of [...group.claude, ...group.codex]) put(group.id, group.id === "unknown" ? `Unknown ${grouping}` : group.label, row);
    }
    // Missing transcripts still belong in the table, even without dated/model activity.
    for (const row of rows) if (!row.buckets.length) put("unknown", `Unknown ${grouping}`, row);
  } else {
    for (const row of rows) {
      if (grouping === "provider") put(row.session.provider, row.session.provider === "claude" ? "Claude" : "Codex", row);
      if (grouping === "project") put(row.session.projectId ?? "unknown", row.session.project, row);
      if (grouping === "workspace") put(row.session.workspaceId ?? "unknown", row.session.workspace || "Unknown workspace", row);
      if (grouping === "label") {
        if (!row.session.labels.length) put("unlabeled", "Unlabeled", row);
        for (const label of new Set(row.session.labels)) put(`label:${label}`, label, row);
      }
      if (grouping === "effort") {
        const subsets = new Map<string, Bucket[]>();
        for (const bucket of row.buckets) {
          const key = bucket.effort ?? "unknown";
          const buckets = subsets.get(key) ?? [];
          buckets.push(bucket);
          subsets.set(key, buckets);
        }
        if (!subsets.size) subsets.set("unknown", []);
        for (const [key, buckets] of subsets) put(key, key === "unknown" ? "Unknown effort" : key, { ...row, buckets, metrics: buckets.reduce((m, b) => addMetrics(m, b.metrics), emptyMetrics()) });
      }
    }
  }
  const lifetimeMetrics = ["provider", "project", "workspace", "label"].includes(grouping);
  return [...groups].map(([key, group]) => ({
    id: JSON.stringify([grouping, key]), ...group, lifetimeMetrics,
    values: Object.fromEntries(DISPLAY_METRICS.map((metric) => [metric,
      !lifetimeMetrics && (metric === "durationMs" || metric === "bytes")
        ? { value: null, known: 0, total: group.rows.length }
        : aggregate(group.rows, metric),
    ])) as TableGroup["values"],
  }));
}
export function sortTableGroups(groups: TableGroup[], key: GroupSortKey, direction: "asc" | "desc"): TableGroup[] {
  return [...groups].sort((a, b) => {
    const av = key === "title" ? a.label : a.values[key].value;
    const bv = key === "title" ? b.label : b.values[key].value;
    if (av === null || bv === null) return av === bv ? a.id.localeCompare(b.id) : av === null ? 1 : -1;
    const order = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return order * (direction === "asc" ? 1 : -1) || a.id.localeCompare(b.id);
  });
}
export function tableGroupsToCsv(groups: TableGroup[], grouping: TableGrouping): string {
  const metrics = DISPLAY_METRICS.filter((key) => key !== "sessions");
  return encodeCsv([
    ["Grouping", "Group", "Sessions", ...metrics.flatMap((key) => [METRICS[key].label, `${METRICS[key].label}: known sessions`])],
    ...groups.map((group) => [grouping, group.label, group.rows.length, ...metrics.flatMap((key) => [group.values[key].value, group.values[key].known])]),
  ]);
}
