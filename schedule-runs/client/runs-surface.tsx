import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  type StyleProp,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { themeScheme } from "../shared/colors";
import {
  EMPTY_FILTERS,
  type RunFilters,
  compareSchedules,
  countBySchedule,
  countByStatus,
  describeCounts,
  filterRuns,
} from "../shared/model";
import { FilterBar } from "./filter-bar";
import { RunRow } from "./run-row";
import { useScheduleRuns } from "./use-schedule-runs";

/**
 * The sidebar surface: every run of every schedule on the selected host, newest first, with
 * the filter bar above. The feed comes from the plugin's server entry every 15 seconds; the
 * filtering is local, so typing never waits on the daemon.
 */

/** How often the relative timestamps and running durations are recomputed. */
const CLOCK_INTERVAL_MS = 30_000;

/**
 * Filter choices survive navigating away and back (the surface unmounts each time) but reset
 * with the app session: plugins have no client storage of their own, and a filter is a viewing
 * preference, not data. The search text is deliberately not kept; a stale query hiding every
 * run is more confusing than retyping it.
 */
const persisted: { filters: RunFilters; includeHeartbeats: boolean } = {
  filters: EMPTY_FILTERS,
  includeHeartbeats: false,
};

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not load the schedule runs.";
}

export function RunsSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const scheme = useMemo(() => themeScheme(theme), [theme]);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const [includeHeartbeats, setIncludeHeartbeats] = useState(persisted.includeHeartbeats);
  const [filters, setFilters] = useState<RunFilters>(() => ({ ...persisted.filters, query: "" }));
  const changeFilters = useCallback((next: RunFilters) => {
    persisted.filters = { ...next, query: "" };
    setFilters(next);
  }, []);
  const changeIncludeHeartbeats = useCallback((next: boolean) => {
    persisted.includeHeartbeats = next;
    setIncludeHeartbeats(next);
  }, []);

  const query = useScheduleRuns(host.id, includeHeartbeats);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  // A fresh feed is the moment relative times are most likely to have moved.
  useEffect(() => {
    if (query.data) setNowMs(Date.now());
  }, [query.data]);

  const runs = query.data?.runs;
  const schedules = useMemo(
    () => [...(query.data?.schedules ?? [])].sort(compareSchedules),
    [query.data?.schedules],
  );
  const scheduleCounts = useMemo(() => countBySchedule(runs ?? []), [runs]);
  const statusCounts = useMemo(() => countByStatus(runs ?? []), [runs]);
  const visible = useMemo(() => filterRuns(runs ?? [], filters), [runs, filters]);

  const total = runs?.length ?? 0;
  const loading = query.isPending;
  const failed = query.isError && !runs;
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  // The breakdown always describes the whole feed; the prefix says how much of it is showing.
  const filtered = visible.length !== total;
  const summary = filtered
    ? `${visible.length} of ${describeCounts(total, statusCounts)}`
    : describeCounts(total, statusCounts);

  return (
    <View style={styles.screen}>
      {/* The screen header above already carries the icon and the "Schedule runs" title, so
          this row only holds what it does not: the count and the refresh affordance. */}
      <View style={styles.header}>
        <Text style={styles.total}>
          {summary}
          {query.data?.truncated ? " (oldest not shown)" : ""}
        </Text>
        {query.isError && runs ? (
          <Text style={styles.staleNote} numberOfLines={1}>
            refresh failed
          </Text>
        ) : null}
        <View style={styles.headerSpacer} />
        <RefreshButton
          theme={theme}
          style={styles.refresh}
          busy={query.isFetching}
          onPress={refresh}
        />
      </View>

      <FilterBar
        filters={filters}
        onChange={changeFilters}
        includeHeartbeats={includeHeartbeats}
        onIncludeHeartbeatsChange={changeIncludeHeartbeats}
        schedules={schedules}
        scheduleCounts={scheduleCounts}
        statusCounts={statusCounts}
        theme={theme}
        scheme={scheme}
        compact={layout.compact}
      />

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{errorMessage(query.error)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the runs"
            onPress={refresh}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : total === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>
            {includeHeartbeats
              ? `No schedule has run yet on ${host.label}`
              : `No schedule has run yet on ${host.label}. Heartbeats are hidden.`}
          </Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>No run matches these filters</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear all filters"
            onPress={() => changeFilters(EMPTY_FILTERS)}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Clear filters</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {visible.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              theme={theme}
              scheme={scheme}
              nowMs={nowMs}
              navigation={navigation}
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function RefreshButton({
  theme,
  style,
  busy,
  onPress,
}: {
  theme: PluginTheme;
  style: StyleProp<ViewStyle>;
  busy: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh the runs"
      accessibilityState={{ busy }}
      hitSlop={6}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={style}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon
          name="RefreshCw"
          size={14}
          color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
        />
      )}
    </Pressable>
  );
}

function createStyles(theme: PluginTheme, compact: boolean) {
  const gutter = compact ? 16 : 24;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: gutter,
      paddingTop: compact ? 8 : 12,
      paddingBottom: 6,
    },
    total: { color: theme.colors.foregroundMuted, fontSize: 13 },
    staleNote: { color: theme.colors.statusWarning, fontSize: 12 },
    headerSpacer: { flex: 1 },
    refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

    scroll: { flex: 1 },
    content: { paddingHorizontal: gutter, paddingVertical: 12, gap: compact ? 8 : 10 },

    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: gutter,
    },
    empty: { color: theme.colors.foregroundMuted, fontSize: 14, textAlign: "center" },
    error: { color: theme.colors.statusDanger, fontSize: 14, textAlign: "center" },
    retry: {
      minHeight: 34,
      paddingVertical: 8,
      paddingHorizontal: 16,
      borderRadius: 9,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    retryPressed: { opacity: 0.85 },
    retryText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
  });
}
