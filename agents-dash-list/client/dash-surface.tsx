import type { PaseoWorkspace } from "@getpaseo/client";
import { type PluginSurfaceProps, type PluginTheme, usePaseo } from "@getpaseo/plugin";
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
import type { DecorationProjectInput } from "../shared/contracts";
import { groupColor, themeScheme } from "../shared/colors";
import {
  DASH_GROUP_DESCRIPTIONS,
  DASH_GROUP_ICONS,
  DASH_GROUP_LABELS,
  type DashGroup,
  buildDashModel,
  quickActionsFor,
} from "../shared/model";
import { useDashDirectory } from "./use-directory";
import { useDecorations } from "./use-decorations";
import { useUnreadMarks } from "./use-unread";
import { WorkspaceRow, buildLabelColors } from "./workspace-row";

/**
 * The sidebar surface: every workspace of the selected host, grouped by what it needs from the
 * user. The workspace and agent directories stream in over the SDK, project icons and the label
 * catalog come from the plugin's server entry, and the grouping itself is `buildDashModel`.
 */

/** How often the relative timestamps are recomputed. */
const CLOCK_INTERVAL_MS = 30_000;
/** The decorations contract accepts at most this many projects per call. */
const MAX_DECORATED_PROJECTS = 500;
/** The unread contract accepts at most this many workspace ids per call. */
const MAX_PRUNE_WORKSPACE_IDS = 2000;
const NO_WORKSPACE_IDS: readonly string[] = [];
/**
 * Groups the user folded shut. Module-level so the choice survives navigating away and back
 * (the surface unmounts each time), while still resetting with the app session: plugins have no
 * storage of their own on the client, and a folded group is a viewing preference, not data.
 */
const collapsedGroups = new Set<DashGroup>();

export function DashSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const directory = useDashDirectory(paseo, host.id);
  const scheme = useMemo(() => themeScheme(theme), [theme]);
  const styles = useMemo(() => createStyles(theme, layout.compact), [theme, layout.compact]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const workspaceIds = useMemo(
    () => [...directory.workspaces.keys()],
    // The maps are mutated in place; `version` is what says they changed.
    [directory.workspaces, directory.version],
  );
  const projects = useMemo(
    () => collectProjects(directory.workspaces.values()),
    [directory.workspaces, directory.version],
  );

  const decorations = useDecorations(host.id, projects);
  const labelColors = useMemo(() => buildLabelColors(decorations.labels), [decorations.labels]);
  // Pruning on the server keys off this list, so it is only handed over once every page of the
  // directory has landed and the whole census still fits the contract; a partial list would
  // permanently delete the marks of the workspaces it omits.
  const pruneIds =
    directory.status === "ready" &&
    directory.complete &&
    workspaceIds.length <= MAX_PRUNE_WORKSPACE_IDS
      ? workspaceIds
      : NO_WORKSPACE_IDS;
  const { marks, setUnread } = useUnreadMarks(host.id, pruneIds);

  const model = useMemo(
    () =>
      buildDashModel({
        workspaces: directory.workspaces.values(),
        agents: directory.agents.values(),
        unreadMarks: marks,
      }),
    [directory.agents, directory.workspaces, directory.version, marks],
  );

  const [collapsed, setCollapsed] = useState<ReadonlySet<DashGroup>>(() => new Set(collapsedGroups));
  const toggleGroup = useCallback((group: DashGroup) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      collapsedGroups.clear();
      for (const entry of next) collapsedGroups.add(entry);
      return next;
    });
  }, []);

  const loading = directory.status === "loading" && model.total === 0;
  const failed = directory.status === "error";

  return (
    <View style={styles.screen}>
      {/* The screen header above already carries the icon and the "Agents dash" title, so this
          row only holds what it does not: the count and the refresh affordance. */}
      <View style={styles.header}>
        <Text style={styles.total}>
          {model.total} {model.total === 1 ? "workspace" : "workspaces"}
        </Text>
        <View style={styles.headerSpacer} />
        <RefreshButton
          theme={theme}
          style={styles.refresh}
          busy={loading}
          onPress={directory.refresh}
        />
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.error}>
            {directory.error ?? "Could not load the workspace directory."}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry loading the dash"
            onPress={directory.refresh}
            style={({ pressed }) => [styles.retry, pressed ? styles.retryPressed : null]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : model.groups.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.empty}>No workspaces on {host.label}</Text>
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {model.groups.map(({ group, workspaces }) => (
            <GroupSection
              key={group}
              group={group}
              count={workspaces.length}
              expanded={!collapsed.has(group)}
              onToggle={toggleGroup}
              theme={theme}
              scheme={scheme}
              styles={styles}
            >
              {workspaces.map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  actions={quickActionsFor(group)}
                  theme={theme}
                  scheme={scheme}
                  hostLabel={host.label}
                  nowMs={nowMs}
                  iconUri={decorations.icons[workspace.projectId] ?? null}
                  labelColors={labelColors}
                  navigation={navigation}
                  paseo={paseo}
                  setUnread={setUnread}
                />
              ))}
            </GroupSection>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/**
 * One status group: a bordered card whose header names the status and folds the rows away.
 * The header is the whole touch target, so collapsing works with a thumb as well as a pointer.
 */
function GroupSection({
  group,
  count,
  expanded,
  onToggle,
  theme,
  scheme,
  styles,
  children,
}: {
  group: DashGroup;
  count: number;
  expanded: boolean;
  onToggle(group: DashGroup): void;
  theme: PluginTheme;
  scheme: ReturnType<typeof themeScheme>;
  styles: SurfaceStyles;
  children: ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const label = DASH_GROUP_LABELS[group];
  return (
    <View style={styles.group}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${count} ${count === 1 ? "workspace" : "workspaces"}`}
        accessibilityHint={DASH_GROUP_DESCRIPTIONS[group]}
        accessibilityState={{ expanded }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => onToggle(group)}
        style={[
          styles.groupHeader,
          hovered ? styles.groupHeaderHovered : null,
          expanded ? styles.groupHeaderExpanded : null,
        ]}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
        <Icon name={DASH_GROUP_ICONS[group]} size={15} color={groupColor(group, theme, scheme)} />
        <Text style={styles.groupLabel} numberOfLines={1}>
          {label}
        </Text>
        <View style={styles.groupCountBadge}>
          <Text style={styles.groupCount}>{count}</Text>
        </View>
      </Pressable>
      {expanded ? <View style={styles.rows}>{children}</View> : null}
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
      accessibilityLabel="Refresh the dash"
      accessibilityState={{ busy }}
      hitSlop={6}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={onPress}
      style={style}
    >
      <Icon
        name="RefreshCw"
        size={14}
        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

/** One decoration request per project, in first-seen order and within the contract's ceiling. */
function collectProjects(workspaces: Iterable<PaseoWorkspace>): DecorationProjectInput[] {
  const projects = new Map<string, DecorationProjectInput>();
  for (const workspace of workspaces) {
    if (!workspace.projectId || !workspace.projectRootPath) continue;
    if (projects.has(workspace.projectId)) continue;
    if (projects.size >= MAX_DECORATED_PROJECTS) break;
    projects.set(workspace.projectId, {
      projectId: workspace.projectId,
      rootPath: workspace.projectRootPath,
      customIconRevision: workspace.projectCustomIconRevision ?? null,
    });
  }
  return [...projects.values()];
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
      paddingBottom: 4,
    },
    total: { color: theme.colors.foregroundMuted, fontSize: 13 },
    headerSpacer: { flex: 1 },
    refresh: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

    scroll: { flex: 1 },
    content: { paddingHorizontal: gutter, paddingVertical: 12, gap: compact ? 12 : 16 },
    group: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      overflow: "hidden",
      backgroundColor: theme.colors.surface0,
    },
    groupHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 12,
      backgroundColor: theme.colors.surface1,
    },
    groupHeaderHovered: { backgroundColor: theme.colors.surface2 },
    groupHeaderExpanded: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    groupLabel: {
      color: theme.colors.foreground,
      fontSize: 14,
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
      backgroundColor: theme.colors.surface0,
      alignItems: "center",
      justifyContent: "center",
    },
    groupCount: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" },
    rows: { paddingVertical: 6, paddingHorizontal: 6, gap: 2 },

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
