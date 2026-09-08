import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AgentMatch, AgentSummary, Snippet } from "../shared/contracts";
import { type ColorScheme, agentStatusColor } from "../shared/colors";
import {
  AGENT_STATUS_LABELS,
  type HistoryWorkspace,
  METADATA_FIELD_LABELS,
  SNIPPET_ROLE_LABELS,
  agentLabel,
  formatTimeAgo,
  parseTime,
  pluralize,
  projectLabel,
  providerLabel,
  workspaceLabel,
} from "../shared/model";

/**
 * One workspace as a card: the head names the workspace, project, branch, and archived state
 * and opens the workspace; the agent rows underneath open their agent. While a transcript
 * search is active, an agent that matched shows a few snippet lines with the matching text in
 * bold (and, in ranked mode, which of its names or paths matched), and one whose history is not
 * on disk says so.
 */

export type CardNavigation = PluginSurfaceProps["navigation"];

export interface WorkspaceCardProps {
  row: HistoryWorkspace;
  /** The row's agents after the provider filter. */
  agents: readonly AgentSummary[];
  /** Transcript hits keyed by agent id; `null` when no transcript search has answered. */
  matches: ReadonlyMap<string, AgentMatch> | null;
  /** A search text is present, so agents should explain their search status. */
  searchActive: boolean;
  theme: PluginTheme;
  scheme: ColorScheme;
  nowMs: number;
  navigation: CardNavigation;
}

/** Web bubbles presses to the card underneath; native ignores the call. */
function stopPropagation(event?: GestureResponderEvent): void {
  event?.stopPropagation?.();
}

function describeTimeAgo(timeAgo: string): string {
  return timeAgo === "now" ? "just now" : timeAgo ? `${timeAgo} ago` : "at an unknown time";
}

function WorkspaceCardImpl({
  row,
  agents,
  matches,
  searchActive,
  theme,
  scheme,
  nowMs,
  navigation,
}: WorkspaceCardProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [hovered, setHovered] = useState(false);
  const name = workspaceLabel(row.workspace);
  const timeAgo = formatTimeAgo(row.lastActivityMs, nowMs);
  const canOpen = Boolean(navigation) && !row.synthetic;
  const openWorkspace = useCallback(() => {
    if (canOpen) navigation?.openWorkspace({ workspaceId: row.workspace.workspaceId });
  }, [canOpen, navigation, row.workspace.workspaceId]);

  // The title says what the workspace is for; project, branch, and worktree name say where.
  const title = row.workspace.title?.trim() || name;
  const meta: { icon: string; text: string }[] = [];
  if (row.project) meta.push({ icon: "FolderGit2", text: projectLabel(row.project) });
  if (row.workspace.branch) meta.push({ icon: "GitBranch", text: row.workspace.branch });
  if (!row.synthetic) meta.push({ icon: "FolderTree", text: name });
  if (row.synthetic) meta.push({ icon: "FolderX", text: "the daemon no longer lists this workspace" });
  meta.push({ icon: "Bot", text: pluralize(row.agents.length, "agent") });

  const head = (
    <>
      <View style={styles.mainLine}>
        <View style={styles.glyph}>
          <Icon
            name={row.synthetic ? "FolderX" : "FolderGit2"}
            size={16}
            color={row.archived ? theme.colors.foregroundMuted : theme.colors.foreground}
          />
        </View>
        <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        {row.archived ? <Badge text="archived" theme={theme} styles={styles} /> : null}
        {timeAgo ? (
          <Text style={styles.time} numberOfLines={1}>
            {timeAgo}
          </Text>
        ) : null}
      </View>
      <View style={styles.metaLine}>
        {meta.map((item) => (
          <MetaItem
            key={`${item.icon}:${item.text}`}
            icon={item.icon}
            text={item.text}
            color={theme.colors.foregroundMuted}
            styles={styles}
          />
        ))}
        {row.workspace.labels.map((label) => (
          <View key={label} style={styles.labelChip}>
            <Text style={styles.labelText} numberOfLines={1}>
              {label}
            </Text>
          </View>
        ))}
      </View>
    </>
  );

  return (
    <View style={[styles.card, hovered ? styles.cardHovered : null]}>
      {canOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open workspace ${title}${title !== name ? ` (${name})` : ""}${row.archived ? ", archived" : ""}, last active ${describeTimeAgo(timeAgo)}`}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={openWorkspace}
          style={({ pressed }) => [styles.head, pressed ? styles.headPressed : null]}
        >
          {head}
        </Pressable>
      ) : (
        <View style={styles.head}>{head}</View>
      )}

      {agents.length > 0 ? (
        <View style={styles.agents}>
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              match={matches?.get(agent.id) ?? null}
              searchActive={searchActive}
              theme={theme}
              scheme={scheme}
              nowMs={nowMs}
              navigation={navigation}
              styles={styles}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.noAgents}>no agents</Text>
      )}
    </View>
  );
}

/** Cards keep their identity across polls thanks to react-query's structural sharing. */
export const WorkspaceCard = memo(WorkspaceCardImpl);

function AgentRow({
  agent,
  match,
  searchActive,
  theme,
  scheme,
  nowMs,
  navigation,
  styles,
}: {
  agent: AgentSummary;
  match: AgentMatch | null;
  searchActive: boolean;
  theme: PluginTheme;
  scheme: ColorScheme;
  nowMs: number;
  navigation: CardNavigation;
  styles: CardStyles;
}) {
  const [hovered, setHovered] = useState(false);
  const title = agentLabel(agent);
  const statusColor = agentStatusColor(agent.status, theme, scheme);
  const timeAgo = formatTimeAgo(parseTime(agent.lastActivityAt) || parseTime(agent.createdAt), nowMs);
  const openAgent = useCallback(
    (event?: GestureResponderEvent) => {
      stopPropagation(event);
      navigation?.openAgent({ agentId: agent.id });
    },
    [agent.id, navigation],
  );

  const detail: { icon: string; text: string; color?: string }[] = [
    { icon: "Bot", text: providerLabel(agent.provider) },
  ];
  if (agent.model) detail.push({ icon: "Cpu", text: agent.model });
  detail.push({ icon: "Activity", text: AGENT_STATUS_LABELS[agent.status], color: statusColor });

  const body = (
    <>
      <View style={styles.agentMain}>
        <View style={styles.agentGlyph}>
          {agent.status === "running" || agent.status === "initializing" ? (
            <ActivityIndicator size="small" color={statusColor} />
          ) : (
            <Icon name="Bot" size={14} color={statusColor} />
          )}
        </View>
        <Text style={styles.agentTitle} numberOfLines={1} ellipsizeMode="tail">
          {title}
        </Text>
        {agent.archivedAt ? <Badge text="archived" theme={theme} styles={styles} /> : null}
        {timeAgo ? (
          <Text style={styles.time} numberOfLines={1}>
            {timeAgo}
          </Text>
        ) : null}
      </View>
      <View style={styles.agentDetail}>
        {detail.map((item) => (
          <MetaItem
            key={item.icon}
            icon={item.icon}
            text={item.text}
            color={item.color ?? theme.colors.foregroundMuted}
            styles={styles}
          />
        ))}
      </View>
    </>
  );

  return (
    <View style={styles.agentRow}>
      {navigation ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open agent ${title}, ${providerLabel(agent.provider)}${agent.archivedAt ? ", archived" : ""}, last active ${describeTimeAgo(timeAgo)}`}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onPress={openAgent}
          style={({ pressed }) => [
            styles.agentPress,
            hovered ? styles.agentHovered : null,
            pressed ? styles.headPressed : null,
          ]}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.agentPress}>{body}</View>
      )}

      {match ? (
        <View style={styles.snippets}>
          {match.metadataHit ? (
            <Text style={styles.metadataHit} numberOfLines={1}>
              {describeMetadataHit(match.metadataFields ?? [])}
            </Text>
          ) : null}
          {match.snippets.map((snippet, index) => (
            <SnippetLine key={`${snippet.file}:${snippet.lineNumber}:${index}`} snippet={snippet} styles={styles} />
          ))}
          {match.truncated ? (
            <Text style={styles.more} numberOfLines={1}>
              {match.hitCount > match.snippets.length
                ? `+ ${match.hitCount - match.snippets.length} more matching lines`
                : "+ more matching lines"}
            </Text>
          ) : null}
        </View>
      ) : searchActive && !agent.transcript.searchable ? (
        <Text style={styles.unsearchable} numberOfLines={1}>
          {agent.transcript.reason === "no-session"
            ? "no conversation recorded yet"
            : agent.transcript.reason === "file-missing"
              ? "conversation file is gone from disk"
              : `${providerLabel(agent.provider)} keeps no conversation file to search`}
        </Text>
      ) : null}
    </View>
  );
}

function describeMetadataHit(fields: readonly string[]): string {
  const labels = fields.map((field) => METADATA_FIELD_LABELS[field] ?? field);
  return labels.length > 0 ? `matches ${labels.join(", ")}` : "matches the agent's details";
}

function SnippetLine({ snippet, styles }: { snippet: Snippet; styles: CardStyles }) {
  return (
    <View style={styles.snippet}>
      <Text style={styles.snippetRole} numberOfLines={1}>
        {SNIPPET_ROLE_LABELS[snippet.role]}
      </Text>
      <Text style={styles.snippetText} numberOfLines={2} selectable>
        {snippet.before}
        {snippet.match ? <Text style={styles.snippetMatch}>{snippet.match}</Text> : null}
        {snippet.after}
        {snippet.clipped ? " (line cut)" : ""}
      </Text>
    </View>
  );
}

/** A 12px glyph and a short muted text, the unit every meta line is built from. */
function MetaItem({
  icon,
  text,
  color,
  styles,
}: {
  icon: string;
  text: string;
  color: string;
  styles: CardStyles;
}) {
  return (
    <View style={styles.metaItem}>
      <Icon name={icon} size={12} color={color} />
      <Text style={[styles.metaText, { color }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function Badge({ text, theme, styles }: { text: string; theme: PluginTheme; styles: CardStyles }) {
  return (
    <View style={styles.badge}>
      <Icon name="Archive" size={10} color={theme.colors.statusWarning} />
      <Text style={styles.badgeText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

type CardStyles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      overflow: "hidden",
    },
    cardHovered: { borderColor: theme.colors.foregroundMuted },
    head: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 4 },
    headPressed: { opacity: 0.85 },
    mainLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    glyph: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
    title: { flex: 1, color: theme.colors.foreground, fontSize: 14, fontWeight: "700" },
    time: { color: theme.colors.foregroundMuted, fontSize: 12 },
    metaLine: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 10,
      rowGap: 4,
      paddingLeft: 26,
    },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
    metaText: { color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 },
    labelChip: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 6,
      backgroundColor: theme.colors.surface2,
    },
    labelText: { color: theme.colors.foregroundMuted, fontSize: 11 },
    badge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusWarning,
    },
    badgeText: { color: theme.colors.statusWarning, fontSize: 11 },
    noAgents: {
      color: theme.colors.foregroundMuted,
      fontSize: 12,
      paddingHorizontal: 12,
      paddingBottom: 10,
      paddingLeft: 38,
    },

    agents: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
      paddingVertical: 4,
      paddingHorizontal: 6,
      gap: 2,
    },
    agentRow: { borderRadius: 8, overflow: "hidden" },
    agentPress: { paddingHorizontal: 6, paddingVertical: 6, gap: 2, borderRadius: 8 },
    agentHovered: { backgroundColor: theme.colors.surface2 },
    agentMain: { flexDirection: "row", alignItems: "center", gap: 8 },
    agentGlyph: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
    agentTitle: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    agentDetail: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 10,
      rowGap: 2,
      paddingLeft: 26,
    },

    snippets: { paddingLeft: 32, paddingRight: 8, paddingBottom: 8, gap: 4 },
    snippet: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    snippetRole: {
      width: 46,
      color: theme.colors.foregroundMuted,
      fontSize: 10,
      fontWeight: "700",
      letterSpacing: 0.4,
      textTransform: "uppercase",
      paddingTop: 2,
    },
    snippetText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    snippetMatch: { color: theme.colors.foreground, fontWeight: "700" },
    more: { color: theme.colors.foregroundMuted, fontSize: 11, paddingLeft: 54 },
    metadataHit: { color: theme.colors.foregroundMuted, fontSize: 11, fontStyle: "italic" },
    unsearchable: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontStyle: "italic",
      paddingLeft: 32,
      paddingBottom: 6,
    },
  });
}
