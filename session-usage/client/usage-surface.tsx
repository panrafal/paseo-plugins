import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Share, Text, View, useWindowDimensions } from "react-native";
import { listUsage } from "../shared/contracts";
import { aggregate, DEFAULT_COLUMNS, DISPLAY_METRICS, EMPTY_FILTERS, dateRange, filterSessions, formatMetric, metricValue, METRICS, recordedEfforts, sortRows, toCsv, type DisplayMetric, type Filters, type SessionRow, type SortKey } from "../shared/model";
import { PRICING_DATE } from "../shared/pricing";
import { groupSessionRows, sortTableGroups, tableGroupsToCsv, TABLE_GROUPINGS, type GroupSortKey, type TableGrouping } from "../shared/table";
import { Charts } from "./charts";
import { GroupDetails } from "./group-details";
import { FilterBar } from "./filter-bar";
import { Dropdown } from "./dropdown";
import { downloadCsv } from "./web";

interface Preferences { filters: Filters; columns: DisplayMetric[]; sort: SortKey; direction: "asc" | "desc"; grouping: TableGrouping; groupSort: GroupSortKey; groupDirection: "asc" | "desc" }
const preferences = new Map<string, Preferences>();
const PAGE_SIZE = 40;

export function UsageSurface(props: PluginSurfaceProps) {
  // A host change also resets transient modal/query state. Never show another host's data.
  return <UsageView key={props.host.id} {...props} />;
}
function UsageView({ theme, layout, host, navigation }: PluginSurfaceProps) {
  const saved = preferences.get(host.id);
  const [filters, setFilters] = useState<Filters>(saved?.filters ?? { ...EMPTY_FILTERS });
  const [columns, setColumns] = useState<DisplayMetric[]>(saved?.columns ?? DEFAULT_COLUMNS);
  const [sort, setSort] = useState<SortKey>(saved?.sort ?? "endedAt");
  const [direction, setDirection] = useState<"asc" | "desc">(saved?.direction ?? "desc");
  const [grouping, setGrouping] = useState<TableGrouping>(saved?.grouping ?? "sessions");
  const [groupSort, setGroupSort] = useState<GroupSortKey>(saved?.groupSort ?? "totalTokens");
  const [groupDirection, setGroupDirection] = useState<"asc" | "desc">(saved?.groupDirection ?? "desc");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const list = useRpc(listUsage);
  const query = useQuery({ queryKey: ["session-usage", host.id], queryFn: () => list({ refresh: false }), refetchInterval: (q) => q.state.data?.scanning ? 2000 : 30_000 });
  const sessions = query.data?.sessions ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = useMemo(() => filterSessions(sessions, filters), [sessions, filters, today]);
  const sorted = useMemo(() => sortRows(rows, sort, direction), [rows, sort, direction]);
  const grouped = grouping !== "sessions";
  const groups = useMemo(() => grouping === "sessions" ? [] : groupSessionRows(rows, grouping), [rows, grouping]);
  const sortedGroups = useMemo(() => sortTableGroups(groups, groupSort, groupDirection), [groups, groupSort, groupDirection]);
  const tableCount = grouped ? sortedGroups.length : sorted.length;
  const pages = Math.max(1, Math.ceil(tableCount / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = sorted.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const visibleGroups = sortedGroups.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const selectedRow = (selectedGroupId ? selectedGroup?.rows : rows)?.find((row) => row.session.id === selected);
  const maxima = useMemo(() => Object.fromEntries([...columns, "sessions" as const].map((key) => [key, grouped
    ? groups.reduce((max, group) => Math.max(max, group.values[key].value ?? 0), 0)
    : rows.reduce((max, row) => Math.max(max, metricValue(row, key) ?? 0), 0),
  ])) as Partial<Record<DisplayMetric, number>>, [columns, grouped, groups, rows]);
  const activeSort = grouped ? groupSort : sort;
  const activeDirection = grouped ? groupDirection : direction;
  const groupingLabel = TABLE_GROUPINGS.find((option) => option.id === grouping)!.label;
  const dateError = dateRange(filters).error;
  const { fontScale } = useWindowDimensions();
  const firstColumnWidth = layout.compact ? 160 : 260;
  // Both panes share vertical scrolling and identical row heights, including scaled text.
  const tableRowHeight = Math.ceil(56 * fontScale + 24);
  const tableHeaderHeight = Math.ceil(40 * fontScale + 24);
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const buttonStyle = { minHeight: 36, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1, justifyContent: "center" as const };
  function remember(next: Partial<Preferences>) { preferences.set(host.id, { filters, columns, sort, direction, grouping, groupSort, groupDirection, ...next }); }
  function closeDetails() { setSelected(null); setSelectedGroupId(null); }
  function changeFilters(value: Filters) { setFilters(value); setPage(0); closeDetails(); remember({ filters: value }); }
  function changeGrouping(value: TableGrouping) { setGrouping(value); setPage(0); closeDetails(); remember({ grouping: value }); }
  function changeSort(key: SortKey) {
    const next = activeSort === key && activeDirection === "desc" ? "asc" : "desc";
    if (grouped) { setGroupSort(key as GroupSortKey); setGroupDirection(next); remember({ groupSort: key as GroupSortKey, groupDirection: next }); }
    else { setSort(key); setDirection(next); remember({ sort: key, direction: next }); }
    setPage(0);
  }
  function header(key: SortKey, title: string, width: number) {
    return <Pressable key={key} accessibilityRole="button" accessibilityLabel={`Sort by ${title}${activeSort === key ? `, ${activeDirection === "asc" ? "ascending" : "descending"}` : ""}`} onPress={() => changeSort(key)} style={{ width, height: tableHeaderHeight, paddingHorizontal: 10, paddingVertical: 12, justifyContent: "center" }}>
      <Text style={{ ...text, fontWeight: "600", color: activeSort === key ? theme.colors.accent : theme.colors.foreground }}>{title}{activeSort === key ? activeDirection === "desc" ? " ↓" : " ↑" : ""}</Text>
    </Pressable>;
  }
  function cell(value: string, width: number) { return <View style={{ width, padding: 10, justifyContent: "center" }}><Text numberOfLines={2} style={text}>{value}</Text></View>; }
  function numericCell(key: DisplayMetric, value: number | null, coverage?: string, width = 142) {
    const max = maxima[key] ?? 0;
    const opacity = value !== null && value > 0 && max > 0 ? 0.04 + 0.2 * Math.min(1, value / max) : 0;
    return <View key={key} testID={`metric-cell-${key}`} accessible accessibilityLabel={`${METRICS[key].label}: ${formatMetric(key, value)}${coverage ? `, ${coverage}` : ""}`} style={{ width, padding: 10, justifyContent: "center", gap: 4, backgroundColor: theme.colors.surface0 }}>
      <View pointerEvents="none" testID={`metric-tint-${key}`} style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: theme.colors.accent, opacity }} />
      <Text style={[text, { fontVariant: ["tabular-nums"], textAlign: "right" }]}>{formatMetric(key, value)}</Text>
      {coverage ? <Text style={[muted, { textAlign: "right" }]}>{coverage}</Text> : null}
    </View>;
  }
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 18 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: layout.compact ? 22 : 26, fontWeight: "700" }}>Session usage</Text>
        <Text style={muted}>Claude & Codex · {host.label} · Active and archived sessions</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" onPress={() => setHelp(true)} style={buttonStyle}><Text style={text}>Metric guide</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={query.data?.scanning || query.isFetching} accessibilityState={{ disabled: query.data?.scanning || query.isFetching }} onPress={async () => { setError(null); try { await list({ refresh: true }); await query.refetch(); } catch { setError("Could not refresh session usage. Try again."); } }} style={[buttonStyle, { opacity: query.data?.scanning ? 0.6 : 1 }]}><Text style={text}>Refresh</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={!tableCount} accessibilityState={{ disabled: !tableCount }} onPress={async () => { try { const csv = grouped ? tableGroupsToCsv(sortedGroups, grouping) : toCsv(sorted); if (!downloadCsv(csv)) await Share.share({ title: "Session usage", message: csv }); } catch { setError("Could not export session usage."); } }} style={buttonStyle}><Text style={text}>Export CSV</Text></Pressable>
      </View>
    </View>
    {query.isPending || query.data?.scanning ? <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}><ActivityIndicator color={theme.colors.accent} /><Text style={muted}>{query.data?.scanning ? `Reading transcripts: ${query.data.completed} / ${query.data.total || "…"}. ${sessions.length ? "Showing the previous completed scan." : "The first scan may take a moment."}` : "Connecting to usage index…"}</Text></View> : null}
    {query.isError || error ? <Text accessibilityRole="alert" style={{ ...text, color: theme.colors.statusDanger }}>{error ?? "Could not load usage from this host. Check the connection and refresh."}</Text> : null}
    {query.data?.warnings.map((warning) => <Text key={warning} style={{ ...muted, color: theme.colors.statusWarning }}>{warning}</Text>)}
    <FilterBar sessions={sessions} filters={filters} onChange={changeFilters} theme={theme} compact={layout.compact} />
    {dateError ? <Text accessibilityRole="alert" style={{ ...text, color: theme.colors.statusDanger }}>{dateError}</Text> : null}
    <Text style={muted}>{rows.length} of {sessions.length} sessions · {rows.filter((r) => r.session.coverage === "partial").length} partial · {rows.filter((r) => r.session.coverage === "missing").length} missing{query.data?.generatedAt ? ` · Updated ${new Date(query.data.generatedAt).toLocaleTimeString()}` : ""}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {(["totalTokens", "cacheRate", "toolCalls", "estimatedCostUsd"] as const).map((key) => {
        const total = aggregate(rows, key);
        return <View key={key} style={{ flexGrow: 1, flexBasis: layout.compact ? "45%" : 180, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 14, gap: 6, backgroundColor: theme.colors.surface1 }}>
          <Text style={muted}>{METRICS[key].label}</Text>
          <Text style={{ ...text, fontSize: layout.compact ? 21 : 25, fontWeight: "600" }}>{formatMetric(key, total.value, true)}</Text>
          <Text style={muted}>{total.known}/{total.total} sessions known</Text>
        </View>;
      })}
    </View>
    <Text style={muted}>Date filters count activity recorded on those UTC days. Cache reads and writes are included in input; reasoning is included in output. Cost estimates use base API rates ({PRICING_DATE}) and do not represent subscription charges.</Text>
    <Charts rows={rows} sessions={sessions} filters={filters} onFiltersChange={changeFilters} theme={theme} compact={layout.compact} />
    <View testID="usage-table" style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text accessibilityRole="header" style={{ ...text, fontSize: 17, fontWeight: "600" }}>{grouped ? "Grouped sessions" : "Sessions"}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, maxWidth: "100%", flexShrink: 1 }}>
          <Dropdown label="Table grouping" summary={groupingLabel} options={TABLE_GROUPINGS} selected={new Set([grouping])} multi={false} onToggle={(id) => changeGrouping(id as TableGrouping)} theme={theme} compact={layout.compact} />
          <Dropdown label="Columns" summary={`${columns.length} metrics`} options={DISPLAY_METRICS.filter((id) => id !== "sessions").map((id) => ({ id, label: METRICS[id].label }))} selected={new Set(columns)} multi onToggle={(id) => { const key = id as DisplayMetric; const next = columns.includes(key) ? columns.filter((v) => v !== key) : [...columns, key]; setColumns(next); remember({ columns: next }); }} clearLabel="Default columns" onClear={() => { setColumns(DEFAULT_COLUMNS); remember({ columns: DEFAULT_COLUMNS }); }} theme={theme} compact={layout.compact} />
        </View>
      </View>
      <Text style={muted}>Press a column to sort, or a {grouped ? "group" : "session"} name for details. Scroll sideways for more metrics. Cell colors use each column’s maximum across all filtered {grouped ? "groups" : "sessions"}. “—” means unknown.</Text>
      {grouped ? <Text testID="table-group-summary" style={muted}>{groups.length} groups · {rows.length} filtered sessions · Totals with weighted percentages. {groups.some((group) => !group.lifetimeMetrics) ? "Session span and transcript size cannot be split across this grouping." : "Session span and transcript size sum the member sessions."}{grouping === "label" ? " Sessions with multiple labels appear in each label group, so group totals can overlap." : ""}</Text> : null}
      <View style={{ flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden" }}>
        <View style={{ width: firstColumnWidth, flexShrink: 0, borderRightWidth: 1, borderRightColor: theme.colors.border }}>
          <View style={{ backgroundColor: theme.colors.surface2 }}>{header("title", grouped ? groupingLabel : "Session", firstColumnWidth)}</View>
          {grouped ? visibleGroups.map((group, i) => <Pressable key={group.id} accessibilityRole="button" accessibilityLabel={`Details for group ${group.label}`} onPress={() => { setSelected(null); setSelectedGroupId(group.id); }} style={{ height: tableRowHeight, padding: 10, gap: 5, justifyContent: "center", backgroundColor: i % 2 ? theme.colors.surface1 : theme.colors.surface0, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Text numberOfLines={2} style={{ ...text, color: theme.colors.accent, fontWeight: "600" }}>{group.label}</Text>
              <Text numberOfLines={1} style={muted}>{group.rows.length} sessions · {group.rows.filter((r) => r.session.coverage !== "available").length} partial or missing</Text>
          </Pressable>) : visible.map((row, i) => <Pressable key={row.session.id} accessibilityRole="button" accessibilityLabel={`Details for ${row.session.title}`} onPress={() => { setSelectedGroupId(null); setSelected(row.session.id); }} style={{ height: tableRowHeight, padding: 10, gap: 5, justifyContent: "center", backgroundColor: i % 2 ? theme.colors.surface1 : theme.colors.surface0, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              <Text numberOfLines={2} style={{ ...text, color: theme.colors.accent, fontWeight: "600" }}>{row.session.title}</Text>
              <Text numberOfLines={1} style={muted}>{[row.session.archived ? "archived" : "active", row.session.kind, row.session.status, row.session.coverage].join(" · ")}</Text>
          </Pressable>)}
        </View>
        <ScrollView horizontal testID="session-usage-metrics" style={{ flex: 1, minWidth: 0 }}>
          <View>
            <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface2 }}>
              {grouped ? header("sessions", "Sessions", 100) : <>{header("provider", "Provider", 100)}{header("project", "Project", 160)}{header("model", "Models", 180)}{header("effort", "Effort", 130)}</>}
              {columns.map((key) => header(key, METRICS[key].label, 142))}
              {!grouped ? <>{header("endedAt", "Last activity", 170)}{header("startedAt", "Started", 170)}</> : null}
            </View>
            {grouped ? visibleGroups.map((group, i) => <View key={group.id} style={{ height: tableRowHeight, flexDirection: "row", backgroundColor: i % 2 ? theme.colors.surface1 : theme.colors.surface0, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              {numericCell("sessions", group.rows.length, undefined, 100)}
              {columns.map((key) => {
                const result = group.values[key];
                const coverage = !group.lifetimeMetrics && (key === "durationMs" || key === "bytes") ? "Not attributable" : result.known < result.total ? `${result.known}/${result.total} known` : undefined;
                return numericCell(key, result.value, coverage);
              })}
            </View>) : visible.map((row, i) => <View key={row.session.id} style={{ height: tableRowHeight, flexDirection: "row", backgroundColor: i % 2 ? theme.colors.surface1 : theme.colors.surface0, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              {cell(row.session.provider === "claude" ? "Claude" : "Codex", 100)}{cell(row.session.project, 160)}{cell([...new Set(row.buckets.map((b) => b.model))].join(", ") || "—", 180)}
              {cell(recordedEfforts(row.buckets).join(", ") || "—", 130)}
              {columns.map((key) => numericCell(key, metricValue(row, key)))}
              {cell(row.session.endedAt ? new Date(row.session.endedAt).toLocaleString() : "—", 170)}{cell(row.session.startedAt ? new Date(row.session.startedAt).toLocaleString() : "—", 170)}
            </View>)}
          </View>
        </ScrollView>
      </View>
      {!tableCount && !query.isPending ? <Text style={muted}>{sessions.length ? "No sessions match these filters." : "No Claude or Codex sessions found on this host."}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable accessibilityRole="button" disabled={currentPage === 0} accessibilityState={{ disabled: currentPage === 0 }} onPress={() => setPage(currentPage - 1)} style={[buttonStyle, { opacity: currentPage === 0 ? 0.4 : 1 }]}><Text style={text}>Previous</Text></Pressable>
        <Text style={muted}>Page {currentPage + 1} / {pages}</Text>
        <Pressable accessibilityRole="button" disabled={currentPage + 1 >= pages} accessibilityState={{ disabled: currentPage + 1 >= pages }} onPress={() => setPage(currentPage + 1)} style={[buttonStyle, { opacity: currentPage + 1 >= pages ? 0.4 : 1 }]}><Text style={text}>Next</Text></Pressable>
      </View>
    </View>
    <Modal title={selectedRow?.session.title ?? selectedGroup?.label ?? "Session details"} open={Boolean(selectedRow || selectedGroup)} onOpenChange={(open) => { if (!open) closeDetails(); }}>
      <Modal.Content>{selectedRow ? <View style={{ gap: 12 }}>
        {selectedGroup ? <Pressable accessibilityRole="button" onPress={() => setSelected(null)} style={{ minHeight: 36, justifyContent: "center" }}><Text style={{ ...text, color: theme.colors.accent }}>Back to group</Text></Pressable> : null}
        <SessionDetails row={selectedRow} theme={theme} navigation={navigation} />
      </View> : selectedGroup ? <GroupDetails key={selectedGroup.id} group={selectedGroup} theme={theme} onSelect={setSelected} /> : <View />}</Modal.Content>
    </Modal>
    <Modal title="Metric guide" open={help} onOpenChange={setHelp}>
      <Modal.Content><View style={{ gap: 14 }}>
        <Text style={muted}>All files are read on the selected host. No transcript content or credentials are returned. Main sessions and subagents count once each. Deleted transcripts remain visible when Paseo still has their records.</Text>
        <Text style={muted}>Rates are a dated standard, short-context API equivalent. Premium processing, long context, region, tools, discounts and plan charges are excluded. Unknown models remain unpriced. “Known” counts rows with a measurement, including partial rows; it is not a guarantee that every request survived.</Text>
        <Text style={muted}>Effort shows the levels recorded by Claude or Codex for the selected activity. Multiple levels are listed together; sorting uses the highest level. “—” means no effort was recorded. Provider defaults are not inferred.</Text>
        {DISPLAY_METRICS.map((key) => <View key={key} style={{ gap: 4 }}><Text style={{ ...text, fontWeight: "600" }}>{METRICS[key].label}</Text><Text style={muted}>{METRICS[key].description}</Text></View>)}
      </View></Modal.Content>
    </Modal>
  </ScrollView>;
}

function SessionDetails({ row, theme, navigation }: { row: SessionRow; theme: PluginSurfaceProps["theme"]; navigation: PluginSurfaceProps["navigation"] }) {
  const { session } = row;
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const tools = new Map<string, number>();
  for (const bucket of row.buckets) for (const [name, count] of Object.entries(bucket.tools)) tools.set(name, (tools.get(name) ?? 0) + count);
  return <View style={{ gap: 12 }}>
    <Text selectable style={muted}>{session.nativeId}</Text>
    <Text selectable style={text}>{session.project}{session.workspace ? ` / ${session.workspace}` : ""}</Text>
    <Text selectable style={muted}>{session.cwd}{session.branch ? ` · ${session.branch}` : ""}</Text>
    <Text style={muted}>{session.provider} · {session.kind} · {session.archived ? "Archived" : "Active"} · {session.coverage}{session.parentId ? ` · Parent: ${session.parentId}` : ""}</Text>
    {session.warnings.map((warning) => <Text key={warning} style={{ ...muted, color: theme.colors.statusWarning }}>{warning}</Text>)}
    {navigation && (session.agentId || session.workspaceId) ? <Pressable accessibilityRole="button" onPress={() => { if (session.agentId) navigation.openAgent({ agentId: session.agentId }); else if (session.workspaceId) navigation.openWorkspace({ workspaceId: session.workspaceId }); }} style={{ minHeight: 40, justifyContent: "center" }}><Text style={{ ...text, color: theme.colors.accent }}>Open {session.agentId ? "agent" : "workspace"}</Text></Pressable> : null}
    <Text style={muted}>Values follow the current filters. Session span and file size always cover the full transcript.</Text>
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 6 }}><Text style={text}>Effort</Text><Text selectable style={[text, { flexShrink: 1 }]}>{recordedEfforts(row.buckets).join(", ") || "—"}</Text></View>
    {DISPLAY_METRICS.filter((key) => key !== "sessions").map((key) => <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 6 }}><Text style={text}>{METRICS[key].label}</Text><Text selectable style={text}>{formatMetric(key, metricValue(row, key))}</Text></View>)}
    <Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: "600" }}>Tool calls by name</Text>
    {[...tools].sort((a, b) => b[1] - a[1]).map(([name, count]) => <View key={name} style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}><Text selectable style={[text, { flexShrink: 1 }]}>{name}</Text><Text style={text}>{count.toLocaleString()}</Text></View>)}
    {!tools.size ? <Text style={muted}>No named tool calls recorded for these filters.</Text> : null}
  </View>;
}
