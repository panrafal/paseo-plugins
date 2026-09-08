import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  createHeartbeat,
  deleteHeartbeat,
  updateHeartbeat,
  type Heartbeat,
} from "../shared/contracts";
import { SCHEDULE_PRESETS, describeCron, parseScheduleInput } from "../shared/schedule-input";
import { useHeartbeats } from "./use-heartbeats";

interface HeartbeatDraft {
  prompt: string;
  cron: string;
  timezone: string | null;
  maxRuns: number | null;
}

export function HeartbeatsPanel({ theme, layout, host, agentId }: PluginAgentPanelProps) {
  const list = useHeartbeats(host.id, agentId);
  const create = useRpc(createHeartbeat);
  const update = useRpc(updateHeartbeat);
  const remove = useRpc(deleteHeartbeat);
  const queryClient = useQueryClient();
  const toast = useToast();
  const styles = useMemo(() => createStyles(theme, layout.compact), [layout.compact, theme]);
  const [editing, setEditing] = useState<Heartbeat | null>(null);
  const [deleting, setDeleting] = useState<Heartbeat | null>(null);
  const [formVersion, setFormVersion] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const cache = (data: { heartbeats: Heartbeat[] }) => {
    queryClient.setQueryData(list.queryKey, data);
  };

  const createMutation = useMutation({
    mutationFn: (draft: HeartbeatDraft) => create({ agentId, ...draft }),
    onSuccess(data) {
      cache(data);
      setFormVersion((value) => value + 1);
      toast.show("Heartbeat scheduled", { variant: "success" });
    },
    onError(error) {
      toast.error(errorMessage(error));
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: HeartbeatDraft }) =>
      update({ id, agentId, ...draft }),
    onSuccess(data) {
      cache(data);
      setEditing(null);
      toast.show("Heartbeat updated", { variant: "success" });
    },
    onError(error) {
      toast.error(errorMessage(error));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => remove({ id, agentId }),
    onSuccess(data) {
      cache(data);
      setDeleting(null);
      toast.show("Heartbeat deleted", { variant: "success" });
    },
    onError(error) {
      toast.error(errorMessage(error));
    },
  });

  const heartbeats = list.query.data?.heartbeats ?? [];
  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.headingRow}>
          <View style={styles.headingCopy}>
            <Text style={styles.title}>Scheduled heartbeats</Text>
            <Text style={styles.body}>
              {heartbeats.length} {heartbeats.length === 1 ? "heartbeat" : "heartbeats"} for this
              agent
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh heartbeats"
            disabled={list.query.isFetching}
            onPress={() => void list.query.refetch()}
            style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}
          >
            {list.query.isFetching ? (
              <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
            ) : (
              <Icon name="RefreshCw" size={16} color={theme.colors.foregroundMuted} />
            )}
          </Pressable>
        </View>

        {list.query.isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : list.query.isError ? (
          <View style={styles.notice}>
            <Text style={styles.error}>{errorMessage(list.query.error)}</Text>
            <SecondaryButton
              label="Retry"
              icon="RefreshCw"
              theme={theme}
              styles={styles}
              onPress={() => void list.query.refetch()}
            />
          </View>
        ) : heartbeats.length === 0 ? (
          <View style={styles.notice}>
            <Icon name="HeartPulse" size={22} color={theme.colors.foregroundMuted} />
            <Text style={styles.body}>No heartbeats are scheduled for this agent.</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {heartbeats.map((heartbeat) =>
              editing?.id === heartbeat.id ? (
                <HeartbeatForm
                  key={heartbeat.id}
                  initial={heartbeat}
                  title="Edit heartbeat"
                  submitLabel="Save changes"
                  busy={updateMutation.isPending}
                  theme={theme}
                  styles={styles}
                  onCancel={() => setEditing(null)}
                  onSubmit={(draft) => updateMutation.mutateAsync({ id: heartbeat.id, draft })}
                />
              ) : (
                <HeartbeatCard
                  key={heartbeat.id}
                  heartbeat={heartbeat}
                  now={now}
                  theme={theme}
                  styles={styles}
                  onEdit={() => setEditing(heartbeat)}
                  onDelete={() => setDeleting(heartbeat)}
                />
              ),
            )}
          </View>
        )}

        <View style={styles.divider} />
        <HeartbeatForm
          key={formVersion}
          title="Add a heartbeat"
          submitLabel="Schedule heartbeat"
          busy={createMutation.isPending}
          theme={theme}
          styles={styles}
          onSubmit={(draft) => createMutation.mutateAsync(draft)}
        />
      </ScrollView>

      <Modal
        title="Delete heartbeat"
        icon={<Icon name="Trash2" size={18} color={theme.colors.statusDanger} />}
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) setDeleting(null);
        }}
      >
        <Modal.Content>
          <View style={styles.modalContent}>
            <Text style={styles.body}>This stops the heartbeat immediately.</Text>
            {deleting ? (
              <Text numberOfLines={4} style={styles.modalPrompt}>
                {deleting.prompt}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <SecondaryButton
                label="Cancel"
                theme={theme}
                styles={styles}
                disabled={deleteMutation.isPending}
                onPress={() => setDeleting(null)}
              />
              <DangerButton
                label={deleteMutation.isPending ? "Deleting…" : "Delete"}
                theme={theme}
                styles={styles}
                disabled={!deleting || deleteMutation.isPending}
                onPress={() => deleting && deleteMutation.mutate(deleting.id)}
              />
            </View>
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function HeartbeatCard({
  heartbeat,
  now,
  theme,
  styles,
  onEdit,
  onDelete,
}: {
  heartbeat: Heartbeat;
  now: number;
  theme: PluginTheme;
  styles: Styles;
  onEdit(): void;
  onDelete(): void;
}) {
  const runs =
    heartbeat.maxRuns === null
      ? `${heartbeat.runCount} / unlimited`
      : `${heartbeat.runCount} / ${heartbeat.maxRuns}`;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardTitleRow}>
          <Icon name="HeartPulse" size={16} color={theme.colors.accent} />
          <Text style={styles.cardTitle} numberOfLines={1}>
            {heartbeat.name ?? "Heartbeat"}
          </Text>
          {heartbeat.status === "paused" ? <Text style={styles.paused}>Paused</Text> : null}
        </View>
        <View style={styles.actions}>
          <SecondaryButton
            label="Edit"
            icon="Pencil"
            theme={theme}
            styles={styles}
            onPress={onEdit}
          />
          <SecondaryButton
            label="Delete"
            icon="Trash2"
            danger
            theme={theme}
            styles={styles}
            onPress={onDelete}
          />
        </View>
      </View>
      <Text style={styles.prompt}>{heartbeat.prompt}</Text>
      <View style={styles.metadata}>
        <Metadata label="Cadence" value={describeCron(heartbeat.cron)} styles={styles} />
        <Metadata label="Cron" value={heartbeat.cron} mono styles={styles} />
        <Metadata label="Time zone" value={heartbeat.timezone ?? "UTC"} styles={styles} />
        <Metadata
          label="Next run"
          value={formatRunTime(heartbeat.nextRunAt, now)}
          styles={styles}
        />
        <Metadata label="Runs" value={runs} styles={styles} />
        <Metadata
          label="Maximum runs"
          value={heartbeat.maxRuns === null ? "Unlimited" : String(heartbeat.maxRuns)}
          styles={styles}
        />
      </View>
    </View>
  );
}

function Metadata({
  label,
  value,
  mono = false,
  styles,
}: {
  label: string;
  value: string;
  mono?: boolean;
  styles: Styles;
}) {
  return (
    <View style={styles.metadataItem}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text style={[styles.metadataValue, mono ? styles.mono : null]} selectable>
        {value}
      </Text>
    </View>
  );
}

function HeartbeatForm({
  initial,
  title,
  submitLabel,
  busy,
  theme,
  styles,
  onSubmit,
  onCancel,
}: {
  initial?: Heartbeat;
  title: string;
  submitLabel: string;
  busy: boolean;
  theme: PluginTheme;
  styles: Styles;
  onSubmit(draft: HeartbeatDraft): Promise<unknown>;
  onCancel?(): void;
}) {
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [schedule, setSchedule] = useState(initial?.cron ?? "");
  const [maxRuns, setMaxRuns] = useState(
    initial?.maxRuns === null || initial?.maxRuns === undefined ? "" : String(initial.maxRuns),
  );
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => {
    try {
      return { value: parseScheduleInput(schedule), error: null };
    } catch (cause) {
      return { value: null, error: schedule.trim() ? errorMessage(cause) : null };
    }
  }, [schedule]);
  const suggestions = useMemo(() => {
    const query = schedule.trim().toLowerCase();
    if (!query) return SCHEDULE_PRESETS.slice(0, 6);
    const words = query.split(/\s+/);
    return SCHEDULE_PRESETS.filter((preset) => {
      const haystack = `${preset.label} ${preset.value} ${preset.detail}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    }).slice(0, 6);
  }, [schedule]);
  const effectiveMaxRuns = preview.value?.oneShot ? 1 : maxRuns.trim() ? Number(maxRuns) : null;

  async function submit() {
    setError(null);
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      setError("Enter the prompt to send to this agent.");
      return;
    }
    let parsed;
    try {
      parsed = parseScheduleInput(schedule);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    let limit: number | null = null;
    if (!parsed.oneShot && maxRuns.trim()) {
      limit = Number.parseInt(maxRuns, 10);
      if (!/^\d+$/.test(maxRuns.trim()) || !Number.isSafeInteger(limit) || limit <= 0) {
        setError("Maximum runs must be a positive whole number or left blank.");
        return;
      }
    }
    try {
      await onSubmit({
        prompt: trimmedPrompt,
        cron: parsed.cron,
        timezone: parsed.oneShot ? "UTC" : (initial?.timezone ?? parsed.timezone),
        maxRuns: parsed.oneShot ? 1 : limit,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.formTitle}>{title}</Text>
      <View style={styles.field}>
        <Text style={styles.label}>Prompt</Text>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder="What should this agent reassess or continue?"
          placeholderTextColor={theme.colors.foregroundMuted}
          multiline
          textAlignVertical="top"
          style={[styles.input, styles.promptInput]}
          editable={!busy}
        />
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>When should it run?</Text>
        <TextInput
          value={schedule}
          onChangeText={setSchedule}
          placeholder="15m, every 15 minutes, or */15 * * * *"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.mono]}
          editable={!busy}
        />
        {suggestions.length > 0 ? (
          <View style={styles.suggestions} accessibilityRole="list">
            {suggestions.map((preset) => (
              <Pressable
                key={preset.value}
                accessibilityRole="button"
                accessibilityLabel={`${preset.label}, ${preset.detail}`}
                disabled={busy}
                onPress={() => setSchedule(preset.value)}
                style={({ pressed }) => [styles.suggestion, pressed ? styles.pressed : null]}
              >
                <Text style={styles.suggestionLabel}>{preset.label}</Text>
                <Text
                  style={[
                    styles.suggestionDetail,
                    preset.detail.includes("*") ? styles.mono : null,
                  ]}
                >
                  {preset.detail}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {preview.value ? (
          <View style={styles.preview}>
            <Icon name="CalendarClock" size={15} color={theme.colors.foregroundMuted} />
            <Text style={styles.previewText}>
              {preview.value.description} · next{" "}
              {new Date(preview.value.nextRunAt).toLocaleString()}
            </Text>
          </View>
        ) : preview.error ? (
          <Text style={styles.error}>{preview.error}</Text>
        ) : null}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Maximum runs</Text>
        <TextInput
          value={preview.value?.oneShot ? "1" : maxRuns}
          onChangeText={setMaxRuns}
          placeholder="Unlimited"
          placeholderTextColor={theme.colors.foregroundMuted}
          keyboardType="number-pad"
          editable={!busy && !preview.value?.oneShot}
          style={[styles.input, styles.smallInput]}
        />
        <Text style={styles.help}>
          {preview.value?.oneShot
            ? "A delay such as 15m is always a single run."
            : "Leave blank for no run limit."}
        </Text>
      </View>
      {initial && (initial.prompt !== prompt.trim() || initial.maxRuns !== effectiveMaxRuns) ? (
        <Text style={styles.help}>
          Changing the prompt or maximum runs replaces the heartbeat and resets its run history.
        </Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {onCancel ? (
          <SecondaryButton
            label="Cancel"
            theme={theme}
            styles={styles}
            disabled={busy}
            onPress={onCancel}
          />
        ) : null}
        <PrimaryButton
          label={busy ? "Saving…" : submitLabel}
          styles={styles}
          disabled={busy}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

function PrimaryButton({
  label,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  label,
  icon,
  danger = false,
  theme,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  icon?: string;
  danger?: boolean;
  theme: PluginTheme;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  const color = danger ? theme.colors.statusDanger : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.secondaryButton,
        danger ? styles.dangerBorder : null,
        disabled ? styles.disabled : null,
        pressed ? styles.pressed : null,
      ]}
    >
      {icon ? <Icon name={icon} size={14} color={color} /> : null}
      <Text style={[styles.secondaryButtonText, danger ? styles.dangerText : null]}>{label}</Text>
    </Pressable>
  );
}

function DangerButton({
  label,
  theme,
  styles,
  disabled = false,
  onPress,
}: {
  label: string;
  theme: PluginTheme;
  styles: Styles;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <SecondaryButton
      label={label}
      icon="Trash2"
      danger
      theme={theme}
      styles={styles}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

function formatRunTime(value: string | null, now: number): string {
  if (!value) return "Not scheduled";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const difference = timestamp - now;
  const absoluteMinutes = Math.max(1, Math.round(Math.abs(difference) / 60_000));
  let relative: string;
  if (absoluteMinutes < 60) relative = `${absoluteMinutes}m`;
  else if (absoluteMinutes < 24 * 60) relative = `${Math.round(absoluteMinutes / 60)}h`;
  else relative = `${Math.round(absoluteMinutes / (24 * 60))}d`;
  return `${new Date(timestamp).toLocaleString()} (${difference >= 0 ? "in" : "overdue by"} ${relative})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error || "The heartbeat operation failed.");
}

function createStyles(theme: PluginTheme, compact: boolean) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.colors.surface0 },
    scroll: { flex: 1 },
    content: {
      width: "100%",
      maxWidth: 900,
      alignSelf: "center",
      padding: compact ? 14 : 24,
      gap: compact ? 14 : 18,
      paddingBottom: 48,
    },
    headingRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    headingCopy: { flex: 1, gap: 3 },
    title: { color: theme.colors.foreground, fontSize: compact ? 20 : 23, fontWeight: "700" },
    body: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
    iconButton: {
      width: 38,
      height: 38,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      alignItems: "center",
      justifyContent: "center",
    },
    centered: { minHeight: 120, alignItems: "center", justifyContent: "center" },
    notice: {
      minHeight: 96,
      padding: 18,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    list: { gap: 12 },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 13 : 16,
      gap: 13,
    },
    cardHeader: {
      flexDirection: compact ? "column" : "row",
      alignItems: compact ? "stretch" : "center",
      gap: 10,
    },
    cardTitleRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
    cardTitle: { flex: 1, color: theme.colors.foreground, fontSize: 15, fontWeight: "700" },
    paused: { color: theme.colors.statusWarning, fontSize: 11, fontWeight: "700" },
    prompt: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
    metadata: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    metadataItem: {
      minWidth: compact ? "47%" : 150,
      flexGrow: 1,
      gap: 3,
      padding: 9,
      borderRadius: 8,
      backgroundColor: theme.colors.surface2,
    },
    metadataLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" },
    metadataValue: { color: theme.colors.foreground, fontSize: 12 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.colors.border,
      marginVertical: 2,
    },
    form: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 12,
      backgroundColor: theme.colors.surface1,
      padding: compact ? 14 : 18,
      gap: 15,
    },
    formTitle: { color: theme.colors.foreground, fontSize: 17, fontWeight: "700" },
    field: { gap: 7 },
    label: { color: theme.colors.foreground, fontSize: 13, fontWeight: "700" },
    input: {
      minHeight: 42,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    },
    promptInput: { minHeight: 100 },
    smallInput: { maxWidth: compact ? "100%" : 180 },
    mono: { fontFamily: "monospace" },
    suggestions: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 9,
      overflow: "hidden",
    },
    suggestion: {
      minHeight: 43,
      paddingHorizontal: 11,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    suggestionLabel: { flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
    suggestionDetail: { color: theme.colors.foregroundMuted, fontSize: 11 },
    preview: { flexDirection: "row", alignItems: "center", gap: 7 },
    previewText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    help: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 },
    error: { color: theme.colors.statusDanger, fontSize: 12, lineHeight: 17 },
    actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
    primaryButton: {
      minHeight: 38,
      paddingVertical: 9,
      paddingHorizontal: 15,
      borderRadius: 8,
      backgroundColor: theme.colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryButtonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
    secondaryButton: {
      minHeight: 36,
      paddingVertical: 8,
      paddingHorizontal: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.border,
      borderRadius: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    secondaryButtonText: { color: theme.colors.foreground, fontSize: 12, fontWeight: "600" },
    dangerBorder: { borderColor: theme.colors.statusDanger },
    dangerText: { color: theme.colors.statusDanger },
    disabled: { opacity: 0.5 },
    pressed: { opacity: 0.7 },
    modalContent: { gap: 14 },
    modalPrompt: {
      color: theme.colors.foreground,
      fontSize: 13,
      lineHeight: 19,
      padding: 11,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
    },
  });
}

type Styles = ReturnType<typeof createStyles>;
