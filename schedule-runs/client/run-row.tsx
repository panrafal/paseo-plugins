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
import type { RunPullRequest, RunRow as RunRowModel } from "../shared/contracts";
import { type ColorScheme, mergedColor, runStatusColor } from "../shared/colors";
import {
  RUN_STATUS_ICONS,
  RUN_STATUS_LABELS,
  formatTimeAgo,
  parseTime,
  previewText,
  pullRequestLabel,
  runDuration,
  runScheduleLabel,
} from "../shared/model";
import { openExternalUrl } from "./open-external-url";
import { RunOutput } from "./run-output";
import { useTranscriptOutput } from "./use-transcript-output";

/**
 * One run as a card. The head (status glyph, schedule name, when it started, elapsed time) and
 * the meta line (workspace, agent, archived badges) plus a three-line preview form the press
 * target that expands the card; the expanded body underneath is plain, so selecting text in
 * the full output never collapses it. Actions sit at the bottom of the expanded body.
 */

export type RowNavigation = PluginSurfaceProps["navigation"];

export interface RunRowProps {
  run: RunRowModel;
  theme: PluginTheme;
  scheme: ColorScheme;
  nowMs: number;
  navigation: RowNavigation;
}

/** Web bubbles presses to the card underneath; native ignores the call. */
function stopPropagation(event?: GestureResponderEvent): void {
  event?.stopPropagation?.();
}

function RunRowImpl({ run, theme, scheme, nowMs, navigation }: RunRowProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const agentId = run.agent?.id ?? null;
  const { state: transcript, load: loadTranscript } = useTranscriptOutput(agentId);

  const scheduleName = runScheduleLabel(run);
  const statusColor = runStatusColor(run.status, theme, scheme);
  const timeAgo = formatTimeAgo(parseTime(run.startedAt), nowMs);
  const duration = runDuration(run, nowMs);
  const preview = run.output ? previewText(run.output) : run.error ? previewText(run.error) : "";

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  // Archived targets are still navigable: the app lands on its recovery screen and offers to
  // unarchive, which beats hiding the way there.
  const canOpenAgent = Boolean(navigation && run.agent?.known);
  const canOpenWorkspace = Boolean(navigation && run.workspace?.known);
  const canLoadTranscript = run.output === null && agentId !== null;

  const openAgent = useCallback(() => {
    if (agentId) navigation?.openAgent({ agentId });
  }, [agentId, navigation]);
  const pullRequestUrl = run.pullRequest?.url ?? null;
  const openPullRequest = useCallback(() => {
    if (pullRequestUrl) void openExternalUrl(pullRequestUrl);
  }, [pullRequestUrl]);
  const openWorkspace = useCallback(() => {
    if (run.workspace) navigation?.openWorkspace({ workspaceId: run.workspace.id });
  }, [navigation, run.workspace]);

  return (
    <View style={[styles.card, hovered ? styles.cardHovered : null]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${RUN_STATUS_LABELS[run.status]} run of ${scheduleName}, started ${timeAgo === "now" ? "just now" : `${timeAgo} ago`}`}
        accessibilityState={{ expanded }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={toggle}
        style={({ pressed }) => [styles.head, pressed ? styles.headPressed : null]}
      >
        <View style={styles.mainLine}>
          <View style={styles.glyph}>
            {run.status === "running" ? (
              <ActivityIndicator size="small" color={statusColor} />
            ) : (
              <Icon name={RUN_STATUS_ICONS[run.status]} size={16} color={statusColor} />
            )}
          </View>
          <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
            {scheduleName}
          </Text>
          {timeAgo ? (
            <Text style={styles.time} numberOfLines={1}>
              {timeAgo}
            </Text>
          ) : null}
          <Icon
            name={expanded ? "ChevronDown" : "ChevronRight"}
            size={14}
            color={theme.colors.foregroundMuted}
          />
        </View>

        <View style={styles.metaLine}>
          <MetaItem
            icon={RUN_STATUS_ICONS[run.status]}
            text={RUN_STATUS_LABELS[run.status]}
            color={statusColor}
            styles={styles}
          />
          {duration ? (
            <MetaItem icon="Timer" text={duration} color={theme.colors.foregroundMuted} styles={styles} />
          ) : null}
          {run.targetType === "agent" ? (
            <MetaItem
              icon="HeartPulse"
              text="heartbeat"
              color={theme.colors.foregroundMuted}
              styles={styles}
            />
          ) : null}
          {run.workspace ? (
            <>
              <MetaItem
                icon="FolderGit2"
                text={
                  run.workspace.known
                    ? [run.workspace.name, run.workspace.branch].filter(Boolean).join(" · ") ||
                      run.workspace.id
                    : "workspace gone"
                }
                color={canOpenWorkspace ? theme.colors.foreground : theme.colors.foregroundMuted}
                styles={styles}
                onPress={canOpenWorkspace ? openWorkspace : undefined}
                accessibilityLabel={
                  canOpenWorkspace ? `Open workspace ${run.workspace.name ?? run.workspace.id}` : undefined
                }
              />
              {run.pullRequest ? (
                <PullRequestLink
                  pullRequest={run.pullRequest}
                  theme={theme}
                  scheme={scheme}
                  styles={styles}
                />
              ) : null}
              {run.workspace.archivedAt ? (
                <Badge label="Workspace archived" theme={theme} styles={styles} />
              ) : null}
            </>
          ) : null}
          {!run.workspace && run.pullRequest ? (
            <PullRequestLink
              pullRequest={run.pullRequest}
              theme={theme}
              scheme={scheme}
              styles={styles}
            />
          ) : null}
          {run.agent ? (
            <>
              <MetaItem
                icon="Bot"
                text={run.agent.known ? run.agent.title?.trim() || "untitled agent" : "agent gone"}
                color={theme.colors.foregroundMuted}
                styles={styles}
              />
              {run.agent.archivedAt ? (
                <Badge label="Agent archived" theme={theme} styles={styles} />
              ) : null}
            </>
          ) : null}
        </View>

        {!expanded && preview ? (
          <Text
            style={[styles.preview, run.output ? null : styles.previewError]}
            numberOfLines={3}
          >
            {preview}
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <View style={styles.body}>
          <RunOutput run={run} transcript={transcript} nowMs={nowMs} theme={theme} />
          {canOpenAgent || canOpenWorkspace || run.pullRequest || canLoadTranscript ? (
            <View style={styles.actions}>
              {canOpenAgent ? (
                <ActionButton
                  icon="Bot"
                  label="Open agent"
                  onPress={openAgent}
                  theme={theme}
                  styles={styles}
                />
              ) : null}
              {canOpenWorkspace ? (
                <ActionButton
                  icon="FolderGit2"
                  label="Open workspace"
                  onPress={openWorkspace}
                  theme={theme}
                  styles={styles}
                />
              ) : null}
              {run.pullRequest ? (
                <ActionButton
                  icon="GitPullRequest"
                  label={`Open ${pullRequestLabel(run.pullRequest)}`}
                  hint={run.pullRequest.title ?? "Opens the pull request in the browser"}
                  onPress={openPullRequest}
                  theme={theme}
                  styles={styles}
                />
              ) : null}
              {canLoadTranscript ? (
                <ActionButton
                  icon="FileText"
                  label="Load from transcript"
                  hint="Reads the agent's last message; this reopens an archived agent's session"
                  busy={transcript.status === "loading"}
                  onPress={loadTranscript}
                  theme={theme}
                  styles={styles}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Rows keep their identity across polls thanks to react-query's structural sharing. */
export const RunRow = memo(RunRowImpl);

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
  const [hovered, setHovered] = useState(false);
  const content = (
    <>
      <Icon name={icon} size={12} color={color} />
      <Text
        style={[styles.metaText, { color }, onPress && hovered ? styles.metaLink : null]}
        numberOfLines={1}
      >
        {text}
      </Text>
    </>
  );
  if (!onPress) return <View style={styles.metaItem}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? text}
      hitSlop={4}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
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

/** `#193` in the pull request's state color; opens the forge page in the browser. */
function PullRequestLink({
  pullRequest,
  theme,
  scheme,
  styles,
}: {
  pullRequest: RunPullRequest;
  theme: PluginTheme;
  scheme: ColorScheme;
  styles: RowStyles;
}) {
  const label = pullRequestLabel(pullRequest);
  const visual =
    pullRequest.state === "merged"
      ? { icon: "GitMerge", color: mergedColor(scheme), text: `${label} merged` }
      : pullRequest.state === "closed"
        ? { icon: "GitPullRequestClosed", color: theme.colors.statusDanger, text: `${label} closed` }
        : pullRequest.state === "open"
          ? { icon: "GitPullRequest", color: theme.colors.statusSuccess, text: label }
          : { icon: "GitPullRequest", color: theme.colors.foreground, text: label };
  return (
    <MetaItem
      icon={visual.icon}
      text={visual.text}
      color={visual.color}
      styles={styles}
      onPress={() => void openExternalUrl(pullRequest.url)}
      accessibilityLabel={`Open pull request ${label}${pullRequest.title ? `: ${pullRequest.title}` : ""}`}
    />
  );
}

/**
 * Archived state as the archive glyph alone: the meta line is already dense, and the word
 * "archived" next to a workspace or an agent adds nothing the icon does not say. The label is
 * what screen readers and the web title read.
 */
function Badge({ label, theme, styles }: { label: string; theme: PluginTheme; styles: RowStyles }) {
  return (
    <View style={styles.badge} accessibilityRole="image" accessibilityLabel={label}>
      <Icon name="Archive" size={11} color={theme.colors.statusWarning} />
    </View>
  );
}

function ActionButton({
  icon,
  label,
  hint,
  busy,
  onPress,
  theme,
  styles,
}: {
  icon: string;
  label: string;
  hint?: string;
  busy?: boolean;
  onPress(): void;
  theme: PluginTheme;
  styles: RowStyles;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ busy: Boolean(busy), disabled: Boolean(busy) }}
      disabled={busy}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={(event) => {
        stopPropagation(event);
        onPress();
      }}
      style={({ pressed }) => [
        styles.action,
        hovered ? styles.actionHovered : null,
        pressed ? styles.actionPressed : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon name={icon} size={13} color={theme.colors.foreground} />
      )}
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

type RowStyles = ReturnType<typeof createStyles>;

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
    head: { paddingVertical: 10, paddingHorizontal: 12, gap: 6 },
    headPressed: { backgroundColor: theme.colors.surface2 },
    mainLine: { flexDirection: "row", alignItems: "center", gap: 8 },
    glyph: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
    title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "700", flex: 1 },
    time: { color: theme.colors.foregroundMuted, fontSize: 12 },
    metaLine: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 10,
      paddingLeft: 26,
    },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" },
    metaText: { fontSize: 12, flexShrink: 1 },
    metaLink: { textDecorationLine: "underline" },
    badge: {
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 3,
      paddingVertical: 2,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.statusWarning,
    },
    preview: {
      color: theme.colors.foregroundMuted,
      fontSize: 13,
      lineHeight: 18,
      paddingLeft: 26,
    },
    previewError: { color: theme.colors.statusDanger },
    body: {
      paddingHorizontal: 12,
      paddingBottom: 12,
      paddingLeft: 38,
      gap: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
      paddingTop: 10,
    },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 32,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    actionHovered: { backgroundColor: theme.colors.surface2 },
    actionPressed: { opacity: 0.8 },
    actionText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
  });
}
