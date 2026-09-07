import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMetrics, type Session } from "../shared/schema";
import { aggregate, chartGroups, EMPTY_FILTERS, filterSessions, metricValue, sortRows, toCsv, dateRange } from "../shared/model";

export function fixture(id: string, provider: "claude" | "codex" = "claude"): Session {
  return { id, nativeId: id, provider, kind: "main", parentId: null, title: id, agentId: id, workspaceId: "w", workspace: "Workspace", projectId: "p", project: "Project", cwd: "/project", branch: "main", labels: ["work"], archived: false, status: "idle", startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-03T00:00:00Z", bytes: 1000, coverage: "available", warnings: [], buckets: [
    { day: "2026-09-01", model: "model-a", metrics: { ...emptyMetrics(), inputTokens: 100, cacheReadTokens: 90, outputTokens: 20, toolCalls: 10, toolErrors: 1 }, tools: { Bash: 10 } },
    { day: "2026-09-02", model: "model-b", metrics: { ...emptyMetrics(), inputTokens: 900, cacheReadTokens: 90, outputTokens: 50, toolCalls: 10, toolErrors: 0 }, tools: { Read: 10 } },
  ] };
}
test("date and model filters select activity buckets, not entire session lifetimes", () => {
  const rows = filterSessions([fixture("a")], { ...EMPTY_FILTERS, period: "custom", from: "2026-09-02", to: "2026-09-02", models: ["model-b"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metrics.inputTokens, 900);
  assert.equal(metricValue(rows[0], "totalTokens"), 950);
  assert.equal(metricValue(rows[0], "durationMs"), 2 * 86_400_000);
  assert.equal(filterSessions([fixture("a")], { ...EMPTY_FILTERS, period: "custom", from: "2026-09-02", models: ["model-a"] }).length, 0);
});
test("weighted percentages, per-session averages and missing coverage remain correct", () => {
  const a = fixture("a"), b = fixture("b", "codex"), missing = fixture("missing");
  a.buckets.splice(1); b.buckets.splice(0, 1); missing.buckets = []; missing.coverage = "missing";
  const rows = filterSessions([a, b, missing], EMPTY_FILTERS);
  assert.equal(aggregate(rows, "cacheRate").value, 0.18);
  assert.deepEqual(aggregate(rows, "inputTokens"), { value: 1000, known: 2, total: 3 });
  assert.equal(aggregate(rows, "inputTokens", true).value, 500);
  assert.equal(aggregate([rows[2]], "inputTokens").value, null);
  assert.equal(sortRows(rows, "inputTokens", "asc").at(-1)?.session.id, "missing");
  assert.equal(sortRows(rows, "inputTokens", "desc").at(-1)?.session.id, "missing");
});
test("chart buckets conserve totals and combine weekly sessions before averaging", () => {
  const rows = filterSessions([fixture("a"), fixture("b", "codex")], EMPTY_FILTERS);
  const groups = chartGroups(rows, "day");
  assert.equal(groups.length, 2);
  assert.equal(groups.reduce((sum, g) => sum + aggregate([...g.claude, ...g.codex], "totalTokens").value!, 0), aggregate(rows, "totalTokens").value);
  const weeks = chartGroups(rows, "week");
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].id, "2026-08-31");
  assert.equal(aggregate(weeks[0].claude, "inputTokens", true).value, 1000);
});
test("project, archived, label, provider, source and missing-data filters compose", () => {
  const a = fixture("a"), b = fixture("b", "codex"); b.archived = true;
  assert.equal(filterSessions([a, b], { ...EMPTY_FILTERS, providers: ["codex"], projects: ["p"], archived: "archived", labels: ["work"] })[0].session.id, "b");
  assert.equal(filterSessions([a, b], { ...EMPTY_FILTERS, source: "external" }).length, 0);
  assert.equal(filterSessions([a, b], { ...EMPTY_FILTERS, labels: ["personal"] }).length, 0);
});
test("date validation rejects impossible dates and reversed ranges", () => {
  assert.ok(dateRange({ ...EMPTY_FILTERS, period: "custom", from: "2026-02-30" }).error);
  assert.ok(dateRange({ ...EMPTY_FILTERS, period: "custom", from: "2026-09-02", to: "2026-09-01" }).error);
  assert.equal(dateRange({ ...EMPTY_FILTERS, period: "7d" }, Date.parse("2026-09-07T12:00:00Z")).from, "2026-09-01");
});
test("CSV uses raw numeric values, escapes quotes and neutralizes spreadsheet formulas", () => {
  const a = fixture("a"); a.title = '=HYPERLINK("danger")';
  const csv = toCsv(filterSessions([a], EMPTY_FILTERS));
  assert.match(csv, /"'=HYPERLINK\(""danger""\)"/);
  assert.ok(csv.includes('"1000"'));
  assert.ok(csv.includes("\r\n"));
});
