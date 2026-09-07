import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Dropdown, type DropdownOption } from "./dropdown";
import { EMPTY_FILTERS, type Filters } from "../shared/model";
import type { Session } from "../shared/schema";

export function FilterBar({ sessions, filters, onChange, theme, compact }: { sessions: Session[]; filters: Filters; onChange(filters: Filters): void; theme: PluginTheme; compact: boolean }) {
  const [more, setMore] = useState(false);
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const input = { ...text, minHeight: 40, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface1, paddingHorizontal: 12 };
  function options(values: { id: string; label: string }[]): DropdownOption[] {
    const result = new Map<string, DropdownOption>();
    for (const value of values) { const prior = result.get(value.id); result.set(value.id, { ...value, count: (prior?.count ?? 0) + 1 }); }
    return [...result.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  function multi(key: "providers" | "projects" | "workspaces" | "labels" | "models", label: string, choices: DropdownOption[]) {
    const selected = filters[key];
    return <Dropdown label={label} summary={!selected.length ? null : selected.length === 1 ? choices.find((o) => o.id === selected[0])?.label ?? selected[0] : `${selected.length} selected`} options={choices} selected={new Set(selected)} multi onToggle={(id) => onChange({ ...filters, [key]: selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id] })} onClear={() => onChange({ ...filters, [key]: [] })} theme={theme} compact={compact} />;
  }
  function single<Key extends "archived" | "source" | "kind" | "coverage" | "period">(key: Key, label: string, values: [Filters[Key], string][]) {
    return <Dropdown label={label} summary={values.find(([id]) => id === filters[key])?.[1] ?? null} options={values.map(([id, label]) => ({ id, label }))} selected={new Set([filters[key]])} multi={false} onToggle={(id) => onChange({ ...filters, [key]: id })} theme={theme} compact={compact} />;
  }
  return <View style={{ gap: 10 }}>
    <TextInput value={filters.query} onChangeText={(query) => onChange({ ...filters, query })} placeholder="Search sessions, projects, branches or models…" placeholderTextColor={theme.colors.foregroundMuted} accessibilityLabel="Search session metadata" style={input} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {multi("providers", "Provider", options(sessions.map((s) => ({ id: s.provider, label: s.provider === "claude" ? "Claude" : "Codex" }))))}
      {multi("projects", "Project", options(sessions.map((s) => ({ id: s.projectId ?? "unknown", label: s.project }))))}
      {single("period", "Period", [["all", "Any time"], ["today", "Today (UTC)"], ["7d", "Last 7 days (UTC)"], ["30d", "Last 30 days (UTC)"], ["90d", "Last 90 days (UTC)"], ["custom", "Custom dates"]])}
      {single("archived", "Archived", [["all", "All"], ["active", "Active only"], ["archived", "Archived only"]])}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore(!more)} style={{ justifyContent: "center", minHeight: 36, paddingHorizontal: 8 }}><Text style={text}>{more ? "Fewer filters" : "More filters"}</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => onChange({ ...EMPTY_FILTERS })} style={{ justifyContent: "center", minHeight: 36, paddingHorizontal: 8 }}><Text style={{ ...text, color: theme.colors.accent }}>Reset filters</Text></Pressable>
    </View>
    {more ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {multi("workspaces", "Workspace", options(sessions.map((s) => ({ id: s.workspaceId ?? "unknown", label: s.workspace || "No workspace" }))))}
      {multi("labels", "Label", options(sessions.flatMap((s) => s.labels.map((label) => ({ id: label, label })))))}
      {multi("models", "Model", options(sessions.flatMap((s) => [...new Set(s.buckets.map((b) => b.model))].map((model) => ({ id: model, label: model })))))}
      {single("source", "Source", [["all", "All local sessions"], ["paseo", "Paseo linked"], ["external", "Outside Paseo"]])}
      {single("kind", "Session", [["all", "Main + subagents"], ["main", "Main only"], ["subagent", "Subagents only"]])}
      {single("coverage", "Data", [["all", "All"], ["available", "Available"], ["partial", "Partial"], ["missing", "Missing"]])}
    </View> : null}
    {filters.period === "custom" ? <View style={{ flexDirection: compact ? "column" : "row", gap: 8 }}>
      <TextInput accessibilityLabel="From UTC date" placeholder="From YYYY-MM-DD" placeholderTextColor={theme.colors.foregroundMuted} value={filters.from} onChangeText={(from) => onChange({ ...filters, from })} style={[input, { flex: compact ? undefined : 1 }]} />
      <TextInput accessibilityLabel="To UTC date" placeholder="To YYYY-MM-DD" placeholderTextColor={theme.colors.foregroundMuted} value={filters.to} onChangeText={(to) => onChange({ ...filters, to })} style={[input, { flex: compact ? undefined : 1 }]} />
    </View> : null}
  </View>;
}
