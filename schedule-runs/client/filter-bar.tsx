import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/react-native";
import { useMemo } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import type { RunStatus, ScheduleSummary, StatusCounts } from "../shared/contracts";
import { RUN_STATUSES } from "../shared/contracts";
import { type ColorScheme, runStatusColor } from "../shared/colors";
import {
  ARCHIVED_MODES,
  ARCHIVED_MODE_LABELS,
  type ArchivedMode,
  RUN_STATUS_ICONS,
  RUN_STATUS_LABELS,
  type RunFilters,
  scheduleLabel,
} from "../shared/model";
import { Chip } from "./chip";
import { Dropdown } from "./dropdown";

/**
 * Every way to narrow the feed: a keyword search, then one dropdown each for schedules and
 * statuses (multi-select; an empty selection means "all"), one for the archived mode
 * (single-select), and a toggle for heartbeats. Dropdowns wrap onto further rows on a phone.
 */
export interface FilterBarProps {
  filters: RunFilters;
  onChange(next: RunFilters): void;
  includeHeartbeats: boolean;
  onIncludeHeartbeatsChange(next: boolean): void;
  schedules: readonly ScheduleSummary[];
  /** Runs per schedule id, across the whole unfiltered feed. */
  scheduleCounts: ReadonlyMap<string, number>;
  statusCounts: StatusCounts;
  theme: PluginTheme;
  scheme: ColorScheme;
  compact: boolean;
}

function toggled<Value>(set: ReadonlySet<Value>, value: Value): Set<Value> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** `Succeeded` for one choice, `2 selected` for more, null for none. */
function summarize(selected: ReadonlySet<string>, labelOf: (id: string) => string): string | null {
  if (selected.size === 0) return null;
  if (selected.size === 1) return labelOf([...selected][0] ?? "");
  return `${selected.size} selected`;
}

export function FilterBar({
  filters,
  onChange,
  includeHeartbeats,
  onIncludeHeartbeatsChange,
  schedules,
  scheduleCounts,
  statusCounts,
  theme,
  scheme,
  compact,
}: FilterBarProps) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const scheduleNames = useMemo(
    () => new Map(schedules.map((schedule) => [schedule.id, scheduleLabel(schedule)])),
    [schedules],
  );
  const scheduleOptions = useMemo(
    () =>
      schedules.map((schedule) => ({
        id: schedule.id,
        label: scheduleLabel(schedule),
        icon: schedule.targetType === "agent" ? "HeartPulse" : undefined,
        count: scheduleCounts.get(schedule.id) ?? 0,
      })),
    [scheduleCounts, schedules],
  );
  const statusOptions = useMemo(
    () =>
      RUN_STATUSES.map((status: RunStatus) => ({
        id: status,
        label: RUN_STATUS_LABELS[status],
        icon: RUN_STATUS_ICONS[status],
        iconColor: runStatusColor(status, theme, scheme),
        count: statusCounts[status],
      })),
    [scheme, statusCounts, theme],
  );
  const archivedOptions = useMemo(
    () => ARCHIVED_MODES.map((mode: ArchivedMode) => ({ id: mode, label: ARCHIVED_MODE_LABELS[mode] })),
    [],
  );
  const archivedSelected = useMemo(() => new Set([filters.archived]), [filters.archived]);

  return (
    <View style={styles.bar}>
      <View style={styles.searchRow}>
        <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
        <TextInput
          accessibilityLabel="Search runs"
          placeholder="Search output, error, schedule, workspace, agent"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={filters.query}
          onChangeText={(query) => onChange({ ...filters, query })}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
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
          label="Schedule"
          icon="CalendarClock"
          summary={summarize(filters.scheduleIds, (id) => scheduleNames.get(id) ?? id)}
          options={scheduleOptions}
          selected={filters.scheduleIds}
          multi
          onToggle={(id) => onChange({ ...filters, scheduleIds: toggled(filters.scheduleIds, id) })}
          onClear={() => onChange({ ...filters, scheduleIds: new Set() })}
          theme={theme}
        />
        <Dropdown
          label="Status"
          icon="Activity"
          summary={summarize(filters.statuses, (id) => RUN_STATUS_LABELS[id as RunStatus] ?? id)}
          options={statusOptions}
          selected={filters.statuses}
          multi
          onToggle={(id) =>
            onChange({ ...filters, statuses: toggled(filters.statuses, id as RunStatus) })
          }
          onClear={() => onChange({ ...filters, statuses: new Set() })}
          theme={theme}
        />
        <Dropdown
          label="Archived"
          icon="Archive"
          summary={filters.archived === "all" ? null : ARCHIVED_MODE_LABELS[filters.archived]}
          options={archivedOptions}
          selected={archivedSelected}
          multi={false}
          onToggle={(id) => onChange({ ...filters, archived: id as ArchivedMode })}
          theme={theme}
        />
        <Chip
          label="Heartbeats"
          icon="HeartPulse"
          role="checkbox"
          selected={includeHeartbeats}
          onPress={() => onIncludeHeartbeatsChange(!includeHeartbeats)}
          theme={theme}
          accessibilityHint="Include schedules that prompt an existing agent"
        />
      </View>
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
  });
}
