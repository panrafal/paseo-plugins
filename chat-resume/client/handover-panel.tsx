import {
  type PluginAgentPanelProps,
  useAgent,
  usePaseo,
} from "@getpaseo/plugin";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { buildHandoverPrompt, HANDOVER_SOURCE_LABEL } from "../shared/handover";

export function HandoverDraftPanel({ agentId, navigation, theme }: PluginAgentPanelProps) {
  const paseo = usePaseo();
  const target = useAgent(agentId, (agent) => ({
    provider: agent.provider,
    sourceAgentId: agent.labels[HANDOVER_SOURCE_LABEL] ?? null,
  }));
  const sourceAgentId = target?.sourceAgentId ?? null;
  const [draft, setDraft] = useState(() =>
    sourceAgentId ? buildHandoverPrompt(sourceAgentId) : "",
  );
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sourceAgentId) setDraft(buildHandoverPrompt(sourceAgentId));
  }, [sourceAgentId]);

  const colors = theme.colors;
  const inputStyle = useMemo(
    () => [
      styles.input,
      { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface1 },
    ],
    [colors],
  );

  async function sendDraft() {
    const prompt = draft.trim();
    if (!prompt || sending || sent) return;
    setSending(true);
    setError(null);
    try {
      await paseo.agents.ref(agentId).send(prompt);
      setSent(true);
      try {
        navigation?.openAgent({ agentId });
      } catch (navigationError) {
        console.warn("[chat-resume] handover started but navigation failed", navigationError);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.surface0 }]}>
      <Text style={[styles.title, { color: colors.foreground }]}>Handover draft</Text>
      <Text style={[styles.help, { color: colors.foregroundMuted }]}>
        Review this prompt before starting the new {target?.provider ?? "provider"} agent.
      </Text>
      <TextInput
        accessibilityLabel="Handover prompt"
        multiline
        onChangeText={setDraft}
        placeholder="Loading handover context…"
        placeholderTextColor={colors.foregroundMuted}
        selectionColor={colors.accent}
        style={inputStyle}
        textAlignVertical="top"
        value={draft}
      />
      {error ? <Text style={[styles.error, { color: colors.statusDanger }]}>{error}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start handover agent"
        disabled={sending || sent || !draft.trim()}
        onPress={() => void sendDraft()}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.accent, opacity: pressed || sending || sent ? 0.7 : 1 },
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.accentForeground }]}>
          {sending ? "Starting…" : sent ? "Started" : "Start agent"}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 12,
    padding: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
  },
  help: {
    fontSize: 13,
    lineHeight: 18,
  },
  input: {
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    fontFamily: "monospace",
    fontSize: 13,
    lineHeight: 19,
    minHeight: 220,
    padding: 12,
  },
  error: {
    fontSize: 13,
  },
  button: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: 8,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 16,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: "600",
  },
});
