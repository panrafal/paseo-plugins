import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { RunRow } from "../shared/contracts";
import { cleanOutput, runDuration } from "../shared/model";
import { Markdown } from "./markdown";
import type { TranscriptState } from "./use-transcript-output";

/**
 * The expanded half of a run card: the complete recorded output (or error) as selectable text,
 * the transcript fallback once loaded, absolute timestamps, and the identifiers needed to find
 * the run elsewhere.
 */
export function RunOutput({
  run,
  transcript,
  nowMs,
  theme,
}: {
  run: RunRow;
  transcript: TranscriptState;
  nowMs: number;
  theme: PluginTheme;
}) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  const output = run.output ? cleanOutput(run.output) : null;

  return (
    <View style={styles.block}>
      {run.error ? (
        <Section title="Error" styles={styles}>
          <Text selectable style={styles.errorText}>
            {run.error}
          </Text>
        </Section>
      ) : null}

      <Section title="Final response" styles={styles}>
        {output ? (
          <>
            <Markdown text={output} theme={theme} />
            {run.outputTruncated ? (
              <Text style={styles.muted}>[output cut at 50,000 characters]</Text>
            ) : null}
          </>
        ) : run.status === "running" ? (
          <Text style={styles.muted}>The run is still going; the response arrives when it ends.</Text>
        ) : (
          <Text style={styles.muted}>No response was recorded for this run.</Text>
        )}
      </Section>

      {transcript.status !== "idle" ? (
        <Section title="From the transcript" styles={styles}>
          {transcript.status === "loading" ? (
            <Text style={styles.muted}>Reading the agent's transcript…</Text>
          ) : transcript.status === "error" ? (
            <Text style={styles.errorText}>{transcript.error}</Text>
          ) : transcript.text ? (
            <Markdown text={cleanOutput(transcript.text)} theme={theme} />
          ) : (
            <Text style={styles.muted}>The transcript holds no assistant message yet.</Text>
          )}
        </Section>
      ) : null}

      <Section title="Details" styles={styles}>
        <Detail label="Scheduled" value={formatAbsolute(run.scheduledFor)} styles={styles} />
        <Detail label="Started" value={formatAbsolute(run.startedAt)} styles={styles} />
        <Detail
          label="Ended"
          value={run.endedAt ? formatAbsolute(run.endedAt) : "still running"}
          styles={styles}
        />
        <Detail label="Duration" value={runDuration(run, nowMs) || "unknown"} styles={styles} />
        <Detail label="Run id" value={run.id} styles={styles} />
        <Detail label="Schedule id" value={run.scheduleId} styles={styles} />
        {run.agent ? <Detail label="Agent id" value={run.agent.id} styles={styles} /> : null}
        {run.workspace ? (
          <Detail label="Workspace id" value={run.workspace.id} styles={styles} />
        ) : null}
      </Section>
    </View>
  );
}

function Section({
  title,
  styles,
  children,
}: {
  title: string;
  styles: OutputStyles;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Detail({ label, value, styles }: { label: string; value: string; styles: OutputStyles }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

function formatAbsolute(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleString();
}

type OutputStyles = ReturnType<typeof createStyles>;

function createStyles(theme: PluginTheme) {
  return StyleSheet.create({
    block: { gap: 12, paddingTop: 4 },
    section: { gap: 4 },
    sectionTitle: {
      color: theme.colors.foregroundMuted,
      fontSize: 11,
      fontWeight: "700",
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    errorText: { color: theme.colors.statusDanger, fontSize: 13, lineHeight: 19 },
    detail: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "baseline" },
    detailLabel: { color: theme.colors.foregroundMuted, fontSize: 12, width: 88 },
    detailValue: { color: theme.colors.foreground, fontSize: 12, flexShrink: 1 },
  });
}
