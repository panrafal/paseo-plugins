import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { DISPLAY_METRICS, formatMetric, METRICS } from "../shared/model";
import type { TableGroup } from "../shared/table";

export function GroupDetails({ group, theme, onSelect }: { group: TableGroup; theme: PluginTheme; onSelect(id: string): void }) {
  const [limit, setLimit] = useState(40);
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return <View style={{ gap: 12 }}>
    <Text style={text}>{group.rows.length} sessions · {group.rows.filter((r) => r.session.coverage === "partial").length} partial · {group.rows.filter((r) => r.session.coverage === "missing").length} missing</Text>
    <Text style={muted}>Totals follow this group and the report filters. Percentages use weighted totals. Known counts show measurement coverage.</Text>
    {!group.lifetimeMetrics ? <Text style={muted}>Session span and transcript size cannot be split across this grouping.</Text> : null}
    {DISPLAY_METRICS.filter((key) => key !== "sessions").map((key) => {
      const result = group.values[key];
      return <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border, paddingVertical: 6 }}>
        <Text style={[text, { flexShrink: 1 }]}>{METRICS[key].label}</Text>
        <View style={{ alignItems: "flex-end", gap: 3 }}><Text selectable style={text}>{formatMetric(key, result.value)}</Text><Text style={muted}>{!group.lifetimeMetrics && (key === "durationMs" || key === "bytes") ? "Not attributable" : `${result.known}/${result.total} known`}</Text></View>
      </View>;
    })}
    <Text accessibilityRole="header" style={{ ...text, fontSize: 16, fontWeight: "600" }}>Sessions in this group</Text>
    {group.rows.slice(0, limit).map((row) => <Pressable key={row.session.id} accessibilityRole="button" accessibilityLabel={`Open session: ${row.session.title}`} onPress={() => onSelect(row.session.id)} style={{ minHeight: 44, justifyContent: "center", gap: 4 }}>
      <Text style={{ ...text, color: theme.colors.accent }}>{row.session.title}</Text>
      <Text style={muted}>{row.session.provider} · {row.session.project} · {row.session.coverage}</Text>
    </Pressable>)}
    {group.rows.length > limit ? <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 40)} style={{ minHeight: 40, justifyContent: "center" }}><Text style={{ ...text, color: theme.colors.accent }}>Show more sessions</Text></Pressable> : null}
  </View>;
}
