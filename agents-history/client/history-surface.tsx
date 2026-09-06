import type { PluginSurfaceProps, PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/react-native";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
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
import type { AgentSummary } from "../shared/contracts";
import { themeScheme } from "../shared/colors";
import {
  EMPTY_FILTERS,
  type HistoryFilters,
  type HistoryWorkspace,
  buildQueryMatcher,
  buildWorkspaces,
  countByLabel,
  countByProject,
  countByProvider,
  filterWorkspaces,
  passesStaticFilters,
  pluralize,
  projectLabel,
  providerLabel,
  visibleAgents,
} from "../shared/model";
import type { DropdownOption } from "./dropdown";
import { FilterBar } from "./filter-bar";
import { useHistory } from "./use-history";
import { isSearchable, useHistorySearch } from "./use-search";
import { WorkspaceCard } from "./workspace-card";

/**
 * The sidebar surface: every workspace the daemon has ever had, archived ones included, with
 * its agents, newest activity first. Filters apply locally; the search text matches names and
 * titles at once and, after a short pause, runs `grep` over the agents' conversation files on
 * the daemon host through the plugin's server entry.
 */

/** How often the relative timestamps are recomputed. */
const CLOCK_INTERVAL_MS = 30_000;

type Group = "active" | "archived";
const GROUP_LABELS: Record<Group, string> = { active: "Active", archived: "Archived" };
const GROUP_ICONS: Record<Group, string> = { active: "FolderOpen", archived: "Archive" };

/**
 * Filter choices survive navigating away and back (the surface unmounts each time) but reset
 * with the app session: plugins have no client storage of their own. The search text is not
 * kept; a stale query hiding everything is more confusing than retyping it.
 */
const persisted: { filters: HistoryFilters; collapsed: Set<Group> } = {
  filters: EMPTY_FILTERS,
  collapsed: new Set(),
};

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not load the history.";
}

export function HistorySurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const scheme = useMemo(() => themeScheme(theme), [theme]);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const [filters, setFilters] = useState<HistoryFilters>(() => ({ ...persisted.filters, query: "" }));
  const changeFilters = useCallback((next: HistoryFilters) => {
    persisted.filters = { ...next, query: "" };
    setFilters(next);
  }, []);
  const [collapsedVersion, setCollapsedVersion] = useState(0);
  const toggleGroup = useCallback((group: Group) => {
    if (persisted.collapsed.has(group)) persisted.collapsed.delete(group);
    else persisted.collapsed.add(group);
    setCollapsedVersion((value) => value + 1);
  }, []);

  const history = useHistory(host.id);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (history.data) setNowMs(Date.now());
  }, [history.data]);

  const rows = useMemo(() => (history.data ? buildWorkspaces(history.data) : []), [history.data]);
  const providerCounts = useMemo(() => countByProvider(rows), [rows]);
  const projectCounts = useMemo(() => countByProject(rows), [rows]);
  const labelOptions = useMemo<DropdownOption[]>(
    () =>
      [...countByLabel(rows).entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, label: id, icon: "Tag", count })),
    [rows],
  );
  const providerOptions = useMemo<DropdownOption[]>(
    () =>
      [...providerCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([id, count]) => ({ id, label: providerLabel(id), icon: "Bot", count })),
    [providerCounts],
  );
  const projectOptions = useMemo<DropdownOption[]>(() => {
    const projects = history.data?.projects ?? [];
    // Two records can share a display name (a checkout and a plain directory); the root path
    // tells them apart.
    const nameCounts = new Map<string, number>();
    for (const project of projects) {
      const label = projectLabel(project);
      nameCounts.set(label, (nameCounts.get(label) ?? 0) + 1);
    }
    return projects
      .map((project) => {
        const label = projectLabel(project);
        return {
          id: project.projectId,
          label: (nameCounts.get(label) ?? 0) > 1 ? `${label} (${project.rootPath})` : label,
          icon: project.archivedAt ? "Archive" : "FolderGit2",
          count: projectCounts.get(project.projectId) ?? 0,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [history.data?.projects, projectCounts]);

  // Agents the static filters keep and whose transcript exists: the grep's search space.
  const staticRows = useMemo(
    () => rows.filter((row) => passesStaticFilters(row, filters, nowMs)),
    [filters, nowMs, rows],
  );
  const searchAgentIds = useMemo(() => {
    const ids: string[] = [];
    for (const row of staticRows) {
      for (const agent of visibleAgents(row, filters)) {
        if (agent.transcript.searchable) ids.push(agent.id);
      }
    }
    return ids;
  }, [filters, staticRows]);

  const search = useHistorySearch(host.id, {
    query: filters.query,
    regex: filters.regex,
    caseSensitive: filters.caseSensitive,
    agentIds: searchAgentIds,
  });

  const searchActive = isSearchable(filters.query);
  const visible = useMemo(
    () => filterWorkspaces(rows, filters, { nowMs, matches: search.matches }),
    [filters, nowMs, rows, search.matches],
  );

  const total = rows.length;
  const loading = history.isPending;
  const failed = history.isError && !history.data;
  const refresh = useCallback(() => {
    void history.refetch();
  }, [history]);

  const visibleAgentCount = useMemo(
    () => visible.reduce((sum, row) => sum + visibleAgents(row, filters).length, 0),
    [filters, visible],
  );
  const summary =
    visible.length === total
      ? `${pluralize(total, "workspace")} · ${pluralize(visibleAgentCount, "agent")}`
      : `${visible.length} of ${pluralize(total, "workspace")} · ${pluralize(visibleAgentCount, "agent")}`;

  const searchNote = useMemo(() => {
    if (!searchActive) return null;
    if (searchAgentIds.length === 0) return "No agent in this selection has a conversation file to search.";
    const result = search.result;
    if (!result) return null;
    const parts = [
      `${pluralize(result.matches.length, "conversation")} matched across ${pluralize(result.searchedAgents, "agent")}`,
    ];
    if (result.unsearchableAgents.length > 0) parts.push(`${result.unsearchableAgents.length} not searchable`);
    if (result.outputTruncated) parts.push("results cut short");
    if (search.capped) parts.push("only the first 2000 agents searched");
    return parts.join(" · ");
  }, [search.capped, search.result, searchActive, searchAgentIds.length]);

  const matcher = useMemo(() => buildQueryMatcher(filters), [filters]);
  const grouped = useMemo(() => {
    if (filters.archived !== "all") return null;
    const active = visible.filter((row) => !row.archived);
    const archived = visible.filter((row) => row.archived);
    return { active, archived };
  }, [filters.archived, visible]);

  const renderCard = (row: HistoryWorkspace) => {
    const agents: AgentSummary[] = visibleAgents(row, filters);
    return (
      <WorkspaceCard
        key={row.id}
        row={row}
        agents={agents}
        matches={search.matches}
        searchActive={searchActive && matcher !== null}
        theme={theme}
        scheme={scheme}
        nowMs={nowMs}
        navigation={navigation}
      />
    );
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.total} numberOfLines={1}>
          {summary}
        </Text>
        {history.isError && history.data ? (
          <Text style={styles.staleNote} numberOfLines={1}>
            refresh failed
          </Text>
        ) : null}
        <View style={styles.headerSpacer} />
        <RefreshButton theme={theme} style={styles.refresh} busy={history.isFetching} onPress={refresh} />
      </View>

      <FilterBar
        filters={filters}
        onChange={changeFilters}
        onSubmit={search.flush}
        providers={providerOptions}
        projects={projectOptions}
        labels={labelOptions}
        searching={search.waiting}
        searchError={search.error}
        searchNote={searchNote}
        theme={theme}
        compact={layout.compact}
      />

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{errorMessage(history.error)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the history"
            onPress={refresh}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : total === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>{`No workspace has been recorded on ${host.label}`}</Text>
        </View>
      ) : visible.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>
            {searchActive && search.waiting
              ? "Searching conversations…"
              : searchActive
                ? "Nothing mentions that in the selected workspaces"
                : "No workspace matches these filters"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear all filters and the search"
            onPress={() => changeFilters(EMPTY_FILTERS)}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Clear filters</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {grouped ? (
            (["active", "archived"] as const).map((group) => {
              const items = grouped[group];
              if (items.length === 0) return null;
              return (
                <GroupSection
                  key={`${group}:${collapsedVersion}`}
                  group={group}
                  count={items.length}
                  expanded={!persisted.collapsed.has(group)}
                  onToggle={toggleGroup}
                  theme={theme}
                  styles={styles}
                >
                  {items.map(renderCard)}
                </GroupSection>
              );
            })
          ) : (
            visible.map(renderCard)
          )}
        </ScrollView>
      )}
    </View>
  );
}

/** One group: a header naming the state that folds its cards away. */
function GroupSection({
  group,
  count,
  expanded,
  onToggle,
  theme,
  styles,
  children,
}: {
  group: Group;
  count: number;
  expanded: boolean;
  onToggle(group: Group): void;
  theme: PluginTheme;
  styles: SurfaceStyles;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const label = GROUP_LABELS[group];
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${pluralize(count, "workspace")}`}
        accessibilityState={{ expanded }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => onToggle(group)}
        style={[styles.groupHeader, hovered ? styles.groupHeaderHovered : null]}
      >
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
        <Icon
          name={GROUP_ICONS[group]}
          size={15}
          color={group === "archived" ? theme.colors.statusWarning : theme.colors.statusSuccess}
        />
        <Text style={styles.groupLabel} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.groupCountBadge}>
          <Text style={styles.groupCount}>{count}</Text>
        </View>
      </Pressable>
      {expanded ? <View style={styles.groupRows}>{children}</View> : null}
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
      accessibilityLabel="Refresh the history"
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
        <Icon name="RefreshCw" size={14} color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted} />
      )}
    </Pressable>
  );
}

type SurfaceStyles = ReturnType<typeof createStyles>;

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
    total: { color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 },
    staleNote: { color: theme.colors.statusWarning, fontSize: 12 },
    headerSpacer: { flex: 1 },
    refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

    scroll: { flex: 1 },
    content: { paddingHorizontal: gutter, paddingVertical: 12, gap: compact ? 10 : 12 },

    group: { gap: compact ? 8 : 10 },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 6,
      paddingHorizontal: 4,
      borderRadius: 8,
    },
    groupHeaderHovered: { backgroundColor: theme.colors.surface1 },
    groupLabel: {
      color: theme.colors.foreground,
      fontSize: 13,
      fontWeight: "700",
      letterSpacing: 0.2,
      flexShrink: 1,
    },
    groupCountBadge: {
      minWidth: 22,
      height: 20,
      paddingHorizontal: 6,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      alignItems: "center",
      justifyContent: "center",
    },
    groupCount: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    groupRows: { gap: compact ? 8 : 10 },

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
