import type { PaseoApi } from "@getpaseo/client";
import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { LabelDefinition, WorkspaceLabelColor } from "../shared/contracts";
import {
  type ColorScheme,
  agentActivityColor,
  deriveIdentityColorName,
  identityFill,
  identityForeground,
  identityTint,
  mergedColor,
  runningColor,
} from "../shared/colors";
import {
  AGENT_ACTIVITY_ICONS,
  AGENT_ACTIVITY_LABELS,
  type DashAgent,
  type DashPullRequest,
  type DashQuickAction,
  type DashWorkspace,
  formatTimeAgo,
  projectInitial,
} from "../shared/model";
import { ArchiveConfirm, describeArchiveRisks } from "./archive-confirm";
import { openExternalUrl } from "./open-external-url";

/**
 * One workspace as three stacked lines: the project icon, workspace name, time and quick
 * actions on one line (the name ellipsizes), a wrapping meta line indented by half the icon
 * (project, branch, host, pull request, checks, review, services, labels), and the agents that
 * live in it as pills. Pressing the row opens its first agent, pressing a pill opens that
 * agent, and the quick actions of the calm groups sit on the right of the main line.
 */

export type RowNavigation = PluginSurfaceProps["navigation"];

export interface WorkspaceRowProps {
  workspace: DashWorkspace;
  /** Quick actions for the group this row was filed under; usually empty. */
  actions: readonly DashQuickAction[];
  theme: PluginTheme;
  scheme: ColorScheme;
  hostLabel: string;
  nowMs: number;
  /** Resolved project icon as a `data:` URI, or null when the server found none. */
  iconUri: string | null;
  labelColors: ReadonlyMap<string, WorkspaceLabelColor>;
  navigation: RowNavigation;
  paseo: PaseoApi;
  setUnread(workspaceId: string, unread: boolean): Promise<void>;
}

/** Catalog names are matched case- and whitespace-insensitively, like the app's label picker. */
export function normalizeLabelName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function buildLabelColors(
  definitions: readonly LabelDefinition[],
): ReadonlyMap<string, WorkspaceLabelColor> {
  const colors = new Map<string, WorkspaceLabelColor>();
  for (const definition of definitions) {
    colors.set(normalizeLabelName(definition.name), definition.color);
  }
  return colors;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Something went wrong.";
}

/** Web bubbles presses to the row underneath; native ignores the call. */
function stopPropagation(event?: GestureResponderEvent): void {
  event?.stopPropagation?.();
}

function WorkspaceRowImpl({
  workspace,
  actions,
  theme,
  scheme,
  hostLabel,
  nowMs,
  iconUri,
  labelColors,
  navigation,
  paseo,
  setUnread,
}: WorkspaceRowProps) {
  const toast = useToast();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Snapshot taken when the dialog opens: the live risks may change (or empty out) while the
  // question is on screen, and the dialog must keep asking about what the user was shown.
  const [confirmRisks, setConfirmRisks] = useState<readonly string[]>([]);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const risks = useMemo(() => describeArchiveRisks(workspace), [workspace]);
  const archivingRemotely = workspace.archivingAt !== null;
  const dimmed = archiving || archivingRemotely;

  // The daemon removes the workspace before it answers the archive call, so this row is usually
  // already unmounted by then: the outcome goes to the toast host, which outlives it, and only
  // the state writes are guarded.
  const archive = useCallback(async () => {
    setArchiving(true);
    try {
      const result = await paseo.workspaces.archive(workspace.id);
      if (result.error) toast.error(result.error);
      else toast.show(`Archived ${workspace.name}`, { variant: "success" });
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      if (aliveRef.current) {
        setArchiving(false);
        setConfirmOpen(false);
      }
    }
  }, [paseo, toast, workspace.id, workspace.name]);

  const handleArchivePress = useCallback(() => {
    if (archiving) return;
    if (risks.length > 0) {
      setConfirmRisks(risks);
      setConfirmOpen(true);
      return;
    }
    void archive();
  }, [archive, archiving, risks]);

  const handleMarkUnread = useCallback(() => {
    void setUnread(workspace.id, true);
  }, [setUnread, workspace.id]);

  const handleRowPress = useCallback(() => {
    if (!navigation) return;
    // A workspace on its way out must not be navigated into: its agents are being torn down.
    if (archiving || archivingRemotely) return;
    const firstAgent = workspace.agents[0];
    if (firstAgent) navigation.openAgent({ agentId: firstAgent.id });
    else navigation.openWorkspace({ workspaceId: workspace.id });
    if (workspace.unreadMarkedAt) void setUnread(workspace.id, false);
  }, [
    archiving,
    archivingRemotely,
    navigation,
    setUnread,
    workspace.agents,
    workspace.id,
    workspace.unreadMarkedAt,
  ]);

  const openAgent = useCallback(
    (agentId: string) => {
      navigation?.openAgent({ agentId });
    },
    [navigation],
  );

  const rightSide = (
    <RowRight
      workspace={workspace}
      actions={actions}
      archiving={archiving}
      timeAgo={formatTimeAgo(workspace.lastActivityAt, nowMs)}
      theme={theme}
      styles={styles}
      onArchive={handleArchivePress}
      onMarkUnread={handleMarkUnread}
    />
  );

  const body = (
    <>
      <View style={styles.mainLine}>
        <ProjectIcon
          uri={iconUri}
          projectId={workspace.projectId}
          projectName={workspace.projectName}
          styles={styles}
        />
        <View style={styles.titleSlot}>
          <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
            {workspace.name}
          </Text>
        </View>
        {rightSide}
      </View>

      <View style={styles.details}>
        <MetaLine
          workspace={workspace}
          hostLabel={hostLabel}
          theme={theme}
          scheme={scheme}
          styles={styles}
          labelColors={labelColors}
          onError={(message) => toast.error(message)}
        />

        <AgentsLine
          agents={workspace.agents}
          theme={theme}
          scheme={scheme}
          styles={styles}
          onOpenAgent={navigation ? openAgent : undefined}
        />
      </View>

    </>
  );

  // The dialog is a sibling of the row, never a child: a press inside it must not also open the
  // workspace underneath. It is mounted lazily — a dash of a few hundred dirty workspaces should
  // not carry a modal per row — but stays mounted afterwards so closing it still animates out.
  const confirm =
    confirmRisks.length > 0 ? (
      <ArchiveConfirm
        open={confirmOpen}
        workspaceName={workspace.name}
        risks={confirmRisks}
        busy={archiving}
        theme={theme}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void archive()}
      />
    ) : null;

  if (!navigation) {
    return (
      <>
        <View style={[styles.row, dimmed ? styles.rowDimmed : null]}>{body}</View>
        {confirm}
      </>
    );
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${workspace.name} in ${workspace.projectName}`}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={handleRowPress}
        style={({ pressed }) => [
          styles.row,
          hovered ? styles.rowHovered : null,
          pressed ? styles.rowPressed : null,
          dimmed ? styles.rowDimmed : null,
        ]}
      >
        {body}
      </Pressable>
      {confirm}
    </>
  );
}

/**
 * Every workspace and agent event rebuilds the whole model, so the surface hands every row a
 * freshly allocated `DashWorkspace`; the default shallow compare would never hit. Comparing the
 * fields the row actually draws keeps a busy directory from re-rendering hundreds of rows.
 */
export const WorkspaceRow = memo(WorkspaceRowImpl, areRowPropsEqual);

function areRowPropsEqual(previous: WorkspaceRowProps, next: WorkspaceRowProps): boolean {
  return (
    previous.actions === next.actions &&
    previous.theme === next.theme &&
    previous.scheme === next.scheme &&
    previous.hostLabel === next.hostLabel &&
    previous.nowMs === next.nowMs &&
    previous.iconUri === next.iconUri &&
    previous.labelColors === next.labelColors &&
    previous.navigation === next.navigation &&
    previous.paseo === next.paseo &&
    previous.setUnread === next.setUnread &&
    isSameWorkspace(previous.workspace, next.workspace)
  );
}

function isSameWorkspace(previous: DashWorkspace, next: DashWorkspace): boolean {
  return (
    previous.id === next.id &&
    previous.name === next.name &&
    previous.projectId === next.projectId &&
    previous.projectName === next.projectName &&
    previous.branch === next.branch &&
    previous.status === next.status &&
    previous.group === next.group &&
    previous.archivingAt === next.archivingAt &&
    previous.lastActivityAt === next.lastActivityAt &&
    previous.unreadMarkedAt === next.unreadMarkedAt &&
    previous.hasUncommittedChanges === next.hasUncommittedChanges &&
    previous.unpushedCommitCount === next.unpushedCommitCount &&
    previous.hasRunningServices === next.hasRunningServices &&
    previous.diffStat?.additions === next.diffStat?.additions &&
    previous.diffStat?.deletions === next.diffStat?.deletions &&
    isSameLabels(previous.labels, next.labels) &&
    isSamePullRequest(previous.pullRequest, next.pullRequest) &&
    isSameAgents(previous.agents, next.agents)
  );
}

function isSameLabels(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((label, index) => label === next[index]);
}

function isSamePullRequest(
  previous: DashPullRequest | null,
  next: DashPullRequest | null,
): boolean {
  if (previous === null || next === null) return previous === next;
  return (
    previous.number === next.number &&
    previous.url === next.url &&
    previous.title === next.title &&
    previous.state === next.state &&
    previous.isDraft === next.isDraft &&
    previous.checks === next.checks &&
    previous.checksCompleted === next.checksCompleted &&
    previous.checksTotal === next.checksTotal &&
    previous.review === next.review &&
    previous.forge === next.forge
  );
}

function isSameAgents(previous: readonly DashAgent[], next: readonly DashAgent[]): boolean {
  if (previous.length !== next.length) return false;
  return previous.every((agent, index) => {
    const other = next[index];
    return (
      other !== undefined &&
      agent.id === other.id &&
      agent.title === other.title &&
      agent.shortName === other.shortName &&
      agent.activity === other.activity
    );
  });
}

/** Time ago plus the group's quick actions; replaced by a caption once the daemon is archiving. */
function RowRight({
  workspace,
  actions,
  archiving,
  timeAgo,
  theme,
  styles,
  onArchive,
  onMarkUnread,
}: {
  workspace: DashWorkspace;
  actions: readonly DashQuickAction[];
  archiving: boolean;
  timeAgo: string;
  theme: PluginTheme;
  styles: RowStyles;
  onArchive(): void;
  onMarkUnread(): void;
}) {
  return (
    <View style={styles.rightSide}>
      {timeAgo ? (
        <Text style={styles.timeAgo} numberOfLines={1}>
          {timeAgo}
        </Text>
      ) : null}
      {workspace.archivingAt !== null ? (
        <Text style={styles.archivingText}>Archiving…</Text>
      ) : (
        actions.map((action) => (
          <QuickAction
            key={action}
            icon={action === "archive" ? "Archive" : "MailOpen"}
            label={
              action === "archive"
                ? `Archive ${workspace.name}`
                : `Mark ${workspace.name} as unread`
            }
            busy={action === "archive" && archiving}
            theme={theme}
            styles={styles}
            onPress={action === "archive" ? onArchive : onMarkUnread}
          />
        ))
      )}
    </View>
  );
}

function AgentsLine({
  agents,
  theme,
  scheme,
  styles,
  onOpenAgent,
}: {
  agents: readonly DashAgent[];
  theme: PluginTheme;
  scheme: ColorScheme;
  styles: RowStyles;
  onOpenAgent?: (agentId: string) => void;
}) {
  return (
    <View style={styles.agentsLine}>
      {agents.length === 0 ? (
        <Text style={styles.noAgents}>No agents</Text>
      ) : (
        agents.map((agent) => (
          <AgentPill
            key={agent.id}
            agent={agent}
            theme={theme}
            scheme={scheme}
            styles={styles}
            onPress={onOpenAgent}
          />
        ))
      )}
    </View>
  );
}

/**
 * Containers React Native's `Image` cannot decode on iOS and Android. The app draws SVG through
 * `react-native-svg` there and shows its own fallback for ICO; plugin code may not require that
 * module, so both degrade to the lettered square on native while web keeps the real artwork.
 */
const NATIVE_UNDECODABLE_ICON_TYPES = new Set([
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

function isDecodableIcon(uri: string): boolean {
  if (Platform.OS === "web") return true;
  const mimeType = /^data:([^;,]+)/.exec(uri)?.[1]?.toLowerCase();
  return mimeType === undefined || !NATIVE_UNDECODABLE_ICON_TYPES.has(mimeType);
}

function ProjectIcon({
  uri,
  projectId,
  projectName,
  styles,
}: {
  uri: string | null;
  projectId: string;
  projectName: string;
  styles: RowStyles;
}) {
  // Truncated or otherwise unreadable bytes must not leave a hole where the icon should be.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [uri]);

  if (!uri || failed || !isDecodableIcon(uri)) {
    return (
      <View
        style={[
          styles.projectFallback,
          { backgroundColor: identityFill(deriveIdentityColorName(projectId)) },
        ]}
      >
        <Text style={styles.projectInitial}>{projectInitial(projectName)}</Text>
      </View>
    );
  }
  // Uploaded artwork is shown whole: no rounding, no cropping, just fitted into the box.
  return (
    <Image
      accessibilityIgnoresInvertColors
      resizeMode="contain"
      source={{ uri }}
      style={styles.projectImage}
      onError={() => setFailed(true)}
    />
  );
}

function QuickAction({
  icon,
  label,
  busy,
  theme,
  styles,
  onPress,
}: {
  icon: string;
  label: string;
  busy: boolean;
  theme: PluginTheme;
  styles: RowStyles;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  if (busy) {
    // Still a Pressable: a bare View would let the press through to the row and navigate into the
    // workspace that is being archived.
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: true, disabled: true }}
        onPress={stopPropagation}
        style={styles.actionButton}
      >
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={(event) => {
        stopPropagation(event);
        onPress();
      }}
      style={styles.actionButton}
    >
      <Icon
        name={icon}
        size={14}
        color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
      />
    </Pressable>
  );
}

interface MetaEntry {
  key: string;
  node: ReactNode;
}

/** Everything a meta item needs beyond the label: which glyph, and in which color. */
interface MetaVisual {
  icon: string;
  color: string;
  text: string;
}

function pullRequestVisual(
  pullRequest: DashPullRequest,
  theme: PluginTheme,
  scheme: ColorScheme,
): MetaVisual {
  const parts = [
    pullRequest.number === null
      ? "PR"
      : `${pullRequest.forge === "gitlab" ? "!" : "#"}${pullRequest.number}`,
  ];
  if (pullRequest.isDraft) parts.push("draft");
  if (pullRequest.state !== "open") parts.push(pullRequest.state);
  const text = parts.join(" ");
  if (pullRequest.state === "merged") {
    return { icon: "GitMerge", color: mergedColor(scheme), text };
  }
  if (pullRequest.state === "closed") {
    return { icon: "GitPullRequestClosed", color: theme.colors.statusDanger, text };
  }
  return { icon: "GitPullRequest", color: theme.colors.statusSuccess, text };
}

/** Null when the forge reported no checks for this pull request. */
function checksVisual(pullRequest: DashPullRequest, theme: PluginTheme): MetaVisual | null {
  switch (pullRequest.checks) {
    case "passed":
      return { icon: "CircleCheck", color: theme.colors.statusSuccess, text: "passed" };
    case "failed":
      return { icon: "CircleX", color: theme.colors.statusDanger, text: "failed" };
    case "running":
      return {
        icon: "LoaderCircle",
        color: theme.colors.statusWarning,
        text: `running ${pullRequest.checksCompleted}/${pullRequest.checksTotal}`,
      };
    default:
      return null;
  }
}

/** Only a decided review on an open pull request is worth a slot on the row. */
function reviewVisual(pullRequest: DashPullRequest, theme: PluginTheme): MetaVisual | null {
  if (pullRequest.state !== "open") return null;
  if (pullRequest.review === "approved") {
    return { icon: "ThumbsUp", color: theme.colors.statusSuccess, text: "approved" };
  }
  if (pullRequest.review === "changes_requested") {
    return { icon: "ThumbsDown", color: theme.colors.statusDanger, text: "changes requested" };
  }
  return null;
}

function MetaLine({
  workspace,
  hostLabel,
  theme,
  scheme,
  styles,
  labelColors,
  onError,
}: {
  workspace: DashWorkspace;
  hostLabel: string;
  theme: PluginTheme;
  scheme: ColorScheme;
  styles: RowStyles;
  labelColors: ReadonlyMap<string, WorkspaceLabelColor>;
  onError(message: string): void;
}) {
  const muted = theme.colors.foregroundMuted;
  const entries: MetaEntry[] = [
    {
      key: "project",
      node: <MetaItem icon="Folder" text={workspace.projectName} color={muted} styles={styles} />,
    },
  ];

  if (workspace.branch) {
    entries.push({
      key: "branch",
      node: <MetaItem icon="GitBranch" text={workspace.branch} color={muted} styles={styles} />,
    });
  }

  entries.push({
    key: "host",
    node: <MetaItem icon="Server" text={hostLabel} color={muted} styles={styles} />,
  });

  const pullRequest = workspace.pullRequest;
  if (pullRequest) {
    const state = pullRequestVisual(pullRequest, theme, scheme);
    entries.push({
      key: "pull-request",
      node: (
        <MetaItem
          icon={state.icon}
          text={state.text}
          color={state.color}
          styles={styles}
          accessibilityLabel={`${pullRequest.title} (${state.text})`}
          onPress={() => {
            openExternalUrl(pullRequest.url).catch((cause: unknown) => {
              onError(errorMessage(cause));
            });
          }}
        />
      ),
    });

    const checks = checksVisual(pullRequest, theme);
    if (checks) {
      entries.push({
        key: "checks",
        node: (
          <MetaItem icon={checks.icon} text={checks.text} color={checks.color} styles={styles} />
        ),
      });
    }

    const review = reviewVisual(pullRequest, theme);
    if (review) {
      entries.push({
        key: "review",
        node: (
          <MetaItem icon={review.icon} text={review.text} color={review.color} styles={styles} />
        ),
      });
    }
  }

  if (workspace.hasRunningServices) {
    entries.push({
      key: "services",
      node: (
        <MetaItem
          icon="Globe"
          text="services"
          color={theme.colors.statusSuccess}
          styles={styles}
          accessibilityLabel="Workspace services running"
        />
      ),
    });
  }

  if (workspace.labels.length > 0) {
    entries.push({
      key: "labels",
      node: (
        <View style={styles.labels}>
          {workspace.labels.map((label) => (
            <LabelChip
              key={label}
              name={label}
              color={labelColors.get(normalizeLabelName(label))}
              scheme={scheme}
              theme={theme}
              styles={styles}
            />
          ))}
        </View>
      ),
    });
  }

  // The separator trails its item rather than leading the next one: the line wraps, and a leading
  // separator would hang alone at the start of the continuation line.
  return (
    <View style={styles.metaLine}>
      {entries.map((entry, index) => (
        <View key={entry.key} style={styles.metaEntry}>
          {entry.node}
          {index < entries.length - 1 ? <Text style={styles.metaSeparator}>·</Text> : null}
        </View>
      ))}
    </View>
  );
}

function MetaItem({
  icon,
  text,
  color,
  styles,
  onPress,
  accessibilityLabel,
}: {
  icon: string;
  text: string;
  color: string;
  styles: RowStyles;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const content = (
    <>
      <Icon name={icon} size={12} color={color} />
      <Text style={[styles.metaText, { color }]} numberOfLines={1}>
        {text}
      </Text>
    </>
  );
  if (!onPress) {
    return <View style={styles.metaItem}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? text}
      hitSlop={4}
      onPress={(event) => {
        stopPropagation(event);
        onPress();
      }}
      style={styles.metaItem}
    >
      {content}
    </Pressable>
  );
}

function LabelChip({
  name,
  color,
  scheme,
  theme,
  styles,
}: {
  name: string;
  color: WorkspaceLabelColor | undefined;
  scheme: ColorScheme;
  theme: PluginTheme;
  styles: RowStyles;
}) {
  // Names the catalog does not know still render, in the neutral chip the sidebar falls back to.
  // That fill is the row's hover color, so the neutral chip is outlined the way the agent pills
  // are: without it the chip dissolves into the row under the pointer.
  const foreground = color ? identityForeground(color, scheme) : theme.colors.foregroundMuted;
  return (
    <View
      style={[
        styles.chip,
        color ? { backgroundColor: identityTint(color) } : styles.chipNeutral,
      ]}
    >
      <Text style={[styles.chipText, { color: foreground }]} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

function AgentPill({
  agent,
  theme,
  scheme,
  styles,
  onPress,
}: {
  agent: DashAgent;
  theme: PluginTheme;
  scheme: ColorScheme;
  styles: RowStyles;
  onPress?: (agentId: string) => void;
}) {
  const working = agent.activity === "working";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${agent.title}: ${AGENT_ACTIVITY_LABELS[agent.activity]}`}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={(event) => {
        stopPropagation(event);
        onPress?.(agent.id);
      }}
      style={({ pressed }) => [styles.pill, pressed ? styles.pillPressed : null]}
    >
      {working ? (
        <ActivityIndicator
          size="small"
          color={runningColor(scheme)}
          style={styles.pillSpinner}
        />
      ) : (
        <Icon
          name={AGENT_ACTIVITY_ICONS[agent.activity]}
          size={12}
          color={agentActivityColor(agent.activity, theme, scheme)}
        />
      )}
      <Text style={styles.pillText} numberOfLines={1}>
        {agent.shortName}
      </Text>
    </Pressable>
  );
}

type RowStyles = ReturnType<typeof createStyles>;

const PROJECT_ICON_SIZE = 20;

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    row: {
      gap: 6,
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
    },
    rowHovered: { backgroundColor: theme.colors.surface1 },
    rowPressed: { backgroundColor: theme.colors.surface2 },
    rowDimmed: { opacity: 0.6 },

    mainLine: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
    titleSlot: { flex: 1, minWidth: 0, overflow: "hidden" },
    name: {
      color: theme.colors.foreground,
      fontSize: 15,
      fontWeight: "500",
      lineHeight: PROJECT_ICON_SIZE,
    },
    rightSide: {
      flexDirection: "row",
      alignItems: "center",
      flexShrink: 0,
      gap: 6,
    },
    timeAgo: { color: theme.colors.foregroundMuted, fontSize: 12 },
    archivingText: { color: theme.colors.foregroundMuted, fontSize: 12, fontStyle: "italic" },
    actionButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },

    projectImage: { width: PROJECT_ICON_SIZE, height: PROJECT_ICON_SIZE, flexShrink: 0 },
    projectFallback: {
      width: PROJECT_ICON_SIZE,
      height: PROJECT_ICON_SIZE,
      flexShrink: 0,
      borderRadius: 5,
      alignItems: "center",
      justifyContent: "center",
    },
    projectInitial: { color: "#ffffff", fontSize: 11, fontWeight: "700" },

    details: { paddingLeft: PROJECT_ICON_SIZE / 2, gap: 6 },
    metaLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", rowGap: 4 },
    metaEntry: { flexDirection: "row", alignItems: "center" },
    metaSeparator: { color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 6 },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 260 },
    metaText: { fontSize: 12, lineHeight: 16 },

    labels: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 4 },
    chip: { borderRadius: 999, paddingHorizontal: 6, maxWidth: 160 },
    chipNeutral: {
      backgroundColor: theme.colors.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    chipText: { fontSize: 12, lineHeight: 16 },

    agentsLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    noAgents: { color: theme.colors.foregroundMuted, fontSize: 12 },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      height: 24,
      borderRadius: 12,
      paddingHorizontal: 8,
      backgroundColor: theme.colors.surface1,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
    },
    pillPressed: { backgroundColor: theme.colors.surface2 },
    pillSpinner: { width: 12, height: 12, transform: [{ scale: 0.6 }] },
    pillText: { color: theme.colors.foreground, fontSize: 12, maxWidth: 180 },
  });
}
