import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  ARCHIVED_MODES,
  ARCHIVED_MODE_LABELS,
  type ArchivedMode,
  type HistoryFilters,
  PERIOD_MODES,
  PERIOD_MODE_LABELS,
  type PeriodMode,
  searchMode,
} from "../shared/model";
import { Chip } from "./chip";
import { Dropdown, type DropdownOption } from "./dropdown";

/**
 * Every way to narrow the list: the search text (metadata instantly, transcripts through the
 * index or grep once typing pauses or Enter is pressed), then dropdowns for archived state,
 * provider, project, and period, and three toggles that choose ranked search, regex, and case
 * sensitivity. Dropdowns wrap onto further rows on a phone.
 */
export interface FilterBarProps {
  filters: HistoryFilters;
  onChange(next: HistoryFilters): void;
  /** Enter in the search box: run the transcript search now. */
  onSubmit(): void;
  providers: readonly DropdownOption[];
  projects: readonly DropdownOption[];
  labels: readonly DropdownOption[];
  /** A transcript search is pending or running. */
  searching: boolean;
  /** Message from the last transcript search, shown under the bar. */
  searchError: string | null;
  /** One line describing the last transcript search, shown under the bar. */
  searchNote: string | null;
  /** State of the search index on this host, shown under the bar in ranked mode. */
  indexNote: string | null;
  theme: PluginTheme;
  compact: boolean;
}

function toggled<Value>(set: ReadonlySet<Value>, value: Value): Set<Value> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** `Claude` for one choice, `2 selected` for more, null for none. */
function summarize(selected: ReadonlySet<string>, labelOf: (id: string) => string): string | null {
  if (selected.size === 0) return null;
  if (selected.size === 1) return labelOf([...selected][0] ?? "");
  return `${selected.size} selected`;
}

export function FilterBar({
  filters,
  onChange,
  onSubmit,
  providers,
  projects,
  labels,
  searching,
  searchError,
  searchNote,
  indexNote,
  theme,
  compact,
}: FilterBarProps) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const ranked = searchMode(filters) === "ranked";
  const providerNames = useMemo(
    () => new Map(providers.map((option) => [option.id, option.label])),
    [providers],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((option) => [option.id, option.label])),
    [projects],
  );
  const labelNames = useMemo(() => new Map(labels.map((option) => [option.id, option.label])), [labels]);
  const archivedOptions = useMemo(
    () => ARCHIVED_MODES.map((mode: ArchivedMode) => ({ id: mode, label: ARCHIVED_MODE_LABELS[mode] })),
    [],
  );
  const periodOptions = useMemo(
    () => PERIOD_MODES.map((mode: PeriodMode) => ({ id: mode, label: PERIOD_MODE_LABELS[mode] })),
    [],
  );
  const archivedSelected = useMemo(() => new Set([filters.archived]), [filters.archived]);
  const periodSelected = useMemo(() => new Set([filters.period]), [filters.period]);

  return (
    <View style={styles.bar}>
      <View style={styles.searchRow}>
        <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          accessibilityLabel="Search workspaces, agents, and conversation history"
          placeholder="Search names, branches, and everything said in conversations"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={filters.query}
          onChangeText={(query) => onChange({ ...filters, query })}
          onSubmitEditing={onSubmit}
          blurOnSubmit={false}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
        {searching ? (
          <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
        ) : null}
        {filters.query.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={6}
            onPress={() => onChange({ ...filters, query: "" })}
            style={styles.clear}
          >
            <Icon name="X" size={14} color={theme.colors.foregroundMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.selectors}>
        <Dropdown
          label="Archived"
          icon="Archive"
          summary={filters.archived === "all" ? null : ARCHIVED_MODE_LABELS[filters.archived]}
          options={archivedOptions}
          selected={archivedSelected}
          multi={false}
          onToggle={(id) => onChange({ ...filters, archived: id as ArchivedMode })}
          theme={theme}
          compact={compact}
        />
        <Dropdown
          label="Provider"
          icon="Bot"
          summary={summarize(filters.providers, (id) => providerNames.get(id) ?? id)}
          options={providers}
          selected={filters.providers}
          multi
          onToggle={(id) => onChange({ ...filters, providers: toggled(filters.providers, id) })}
          onClear={() => onChange({ ...filters, providers: new Set() })}
          theme={theme}
          compact={compact}
        />
        <Dropdown
          label="Project"
          icon="FolderGit2"
          summary={summarize(filters.projectIds, (id) => projectNames.get(id) ?? id)}
          options={projects}
          selected={filters.projectIds}
          multi
          onToggle={(id) => onChange({ ...filters, projectIds: toggled(filters.projectIds, id) })}
          onClear={() => onChange({ ...filters, projectIds: new Set() })}
          theme={theme}
          compact={compact}
        />
        <Dropdown
          label="Label"
          icon="Tag"
          summary={summarize(filters.labels, (id) => labelNames.get(id) ?? id)}
          options={labels}
          selected={filters.labels}
          multi
          onToggle={(id) => onChange({ ...filters, labels: toggled(filters.labels, id) })}
          onClear={() => onChange({ ...filters, labels: new Set() })}
          theme={theme}
          compact={compact}
        />
        <Dropdown
          label="Period"
          icon="CalendarClock"
          summary={filters.period === "all" ? null : PERIOD_MODE_LABELS[filters.period]}
          options={periodOptions}
          selected={periodSelected}
          multi={false}
          onToggle={(id) => onChange({ ...filters, period: id as PeriodMode })}
          theme={theme}
          compact={compact}
        />
        <Chip
          label="Ranked"
          icon="Sparkles"
          role="checkbox"
          selected={filters.ranked && !filters.regex}
          disabled={filters.regex}
          onPress={() => onChange({ ...filters, ranked: !filters.ranked })}
          theme={theme}
          accessibilityHint={
            filters.regex
              ? "Regex searches run through grep without ranking"
              : "Rank conversations by how well they match, names and titles first"
          }
        />
        <Chip
          label="Regex"
          icon="Regex"
          role="checkbox"
          selected={filters.regex}
          onPress={() => onChange({ ...filters, regex: !filters.regex })}
          theme={theme}
          accessibilityHint="Treat the search text as an extended regular expression, searched with grep"
        />
        <Chip
          label="Aa"
          icon="CaseSensitive"
          role="checkbox"
          selected={filters.caseSensitive}
          disabled={ranked}
          onPress={() => onChange({ ...filters, caseSensitive: !filters.caseSensitive })}
          theme={theme}
          accessibilityHint={ranked ? "Ranked search ignores letter case" : "Match the letter case exactly"}
        />
      </View>

      {searchError ? (
        <Text style={styles.error} numberOfLines={2}>
          {searchError}
        </Text>
      ) : searchNote ? (
        <Text style={styles.note} numberOfLines={1}>
          {searchNote}
        </Text>
      ) : null}
      {indexNote ? (
        <Text style={styles.note} numberOfLines={1}>
          {indexNote}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: PluginTheme, compact: boolean) {
  const gutter = compact ? 16 : 24;
  return StyleSheet.create({
    bar: {
      paddingHorizontal: gutter,
      paddingBottom: 10,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 36,
      paddingHorizontal: 10,
      borderRadius: 9,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    searchInput: {
      flex: 1,
      color: theme.colors.foreground,
      fontSize: 13,
      paddingVertical: 6,
      minWidth: 0,
    },
    clear: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
    selectors: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    error: { color: theme.colors.statusWarning, fontSize: 12 },
    note: { color: theme.colors.foregroundMuted, fontSize: 12 },
  });
}
