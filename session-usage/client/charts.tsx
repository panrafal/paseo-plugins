import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { aggregate, chartGroups, DISPLAY_METRICS, formatMetric, METRICS, type DisplayMetric, type Filters, type Grouping, type SessionRow } from "../shared/model";
import type { Session } from "../shared/schema";
import { ActivityCalendar } from "./activity-calendar";
import { Dropdown } from "./dropdown";

const GROUPS: { id: Grouping; label: string }[] = [{ id: "provider", label: "Provider" }, { id: "day", label: "Day" }, { id: "week", label: "Week (Monday)" }, { id: "month", label: "Month" }, { id: "project", label: "Project" }, { id: "model", label: "Model" }];
export function Charts({ rows, sessions, filters, onFiltersChange, theme, compact }: { rows: SessionRow[]; sessions: Session[]; filters: Filters; onFiltersChange(filters: Filters): void; theme: PluginTheme; compact: boolean }) {
  const [metric, setMetric] = useState<DisplayMetric>("totalTokens");
  const [grouping, setGrouping] = useState<Grouping>("provider");
  const [average, setAverage] = useState(false);
  const [limit, setLimit] = useState(14);
  const groups = useMemo(() => chartGroups(rows, grouping), [rows, grouping]);
  const lifetimeMetric = metric === "durationMs" || metric === "bytes";
  const restricted = lifetimeMetric && !["provider", "project"].includes(grouping);
  const values = groups.map((group) => ({ group, claude: aggregate(group.claude, metric, average), codex: aggregate(group.codex, metric, average) }));
  const max = Math.max(...values.flatMap((v) => [v.claude.value ?? 0, v.codex.value ?? 0]), 0);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const temporal = ["day", "week", "month"].includes(grouping);
  const visible = temporal ? values.slice(-limit) : values.slice(0, limit);
  return <><View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: compact ? 12 : 16, gap: 12, backgroundColor: theme.colors.surface1 }}>
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>Compare providers</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Dropdown label="Metric" summary={METRICS[metric].label} options={DISPLAY_METRICS.map((id) => ({ id, label: METRICS[id].label }))} selected={new Set([metric])} multi={false} onToggle={(id) => setMetric(id as DisplayMetric)} theme={theme} compact={compact} />
      <Dropdown label="Group by" summary={GROUPS.find((g) => g.id === grouping)!.label} options={GROUPS} selected={new Set([grouping])} multi={false} onToggle={(id) => { setGrouping(id as Grouping); setLimit(14); }} theme={theme} compact={compact} />
      <Dropdown label="Show" summary={average ? "Per known session" : "Total"} options={[{ id: "total", label: "Total" }, { id: "average", label: "Per known session" }]} selected={new Set([average ? "average" : "total"])} multi={false} onToggle={(id) => setAverage(id === "average")} theme={theme} compact={compact} />
    </View>
    <Text style={muted}>{METRICS[metric].description}</Text>
    {restricted ? <Text style={muted}>Choose Provider or Project for lifetime measurements.</Text> : visible.length === 0 ? <Text style={muted}>No sessions match these filters.</Text> : <View style={{ gap: 16 }}>
      {visible.map(({ group, ...series }) => <View key={group.id} style={{ gap: 6 }}>
        {grouping !== "provider" ? <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{group.label}</Text> : null}
        {(["claude", "codex"] as const).map((provider) => {
          const result = series[provider];
          const color = provider === "claude" ? theme.colors.accent : theme.colors.statusSuccess;
          const label = provider === "claude" ? "Claude" : "Codex";
          return <View key={provider} accessible accessibilityLabel={`${group.label}, ${label}, ${METRICS[metric].label}: ${formatMetric(metric, result.value)}, ${result.known} of ${result.total} sessions have this measurement`} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{label}</Text>
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{formatMetric(metric, result.value)} <Text style={muted}>· {result.known}/{result.total} known</Text></Text>
            </View>
            <View style={{ height: 12, borderRadius: 3, overflow: "hidden", backgroundColor: theme.colors.surface2 }}>
              <View style={{ height: 12, width: `${max && result.value !== null ? Math.min(100, result.value / max * 100) : 0}%`, borderRadius: 3, backgroundColor: color }} />
            </View>
          </View>;
        })}
      </View>)}
    </View>}
    {!restricted && groups.length > limit ? <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 30)} style={{ minHeight: 36, justifyContent: "center" }}><Text style={{ color: theme.colors.accent, fontSize: 13 }}>Showing {temporal ? "latest " : ""}{visible.length} of {groups.length} groups · Show more</Text></Pressable> : null}
    <Text style={muted}>Bars start at zero on a shared scale. Values are known subtotals; “—” means unknown. Percentages use weighted totals. Dates use UTC.</Text>
  </View>
    <ActivityCalendar sessions={sessions} filters={filters} onChange={onFiltersChange} metric={metric} average={average} theme={theme} compact={compact} />
  </>;
}
