import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin";
import { Icon, useToast } from "@getpaseo/plugin/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useEffect, useMemo, useState } from "react";
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
  CURSOR_REMOTE_PREFIX,
  type EditorKind,
  type EditorSettings,
  VSCODE_REMOTE_PREFIX,
  getEditorSettings,
  setEditorSettings,
} from "../shared/settings";
import { desktopRemoteUrl, mobileRemoteUrl } from "../shared/url";

const SETTINGS_QUERY_KEY = ["vscode-open-remote", "settings"] as const;

export function SettingsSurface({ theme, layout, host }: PluginSurfaceProps) {
  const getSettings = useRpc(getEditorSettings);
  const saveSettings = useRpc(setEditorSettings);
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => getSettings({}),
  });
  const [kind, setKind] = useState<EditorKind>("vscode");
  const [customPrefix, setCustomPrefix] = useState("");

  useEffect(() => {
    if (!query.data) return;
    setKind(query.data.kind);
    setCustomPrefix(query.data.kind === "custom" ? query.data.prefix : "");
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (settings: EditorSettings) => saveSettings(settings),
    onSuccess(settings) {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, settings);
      toast.show("Remote editor saved", { variant: "success" });
    },
    onError(error) {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const styles = useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: {
          width: "100%",
          maxWidth: 760,
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 16 : 20,
        },
        header: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
        headerCopy: { flex: 1, gap: 4 },
        title: { color: theme.colors.foreground, fontSize: 22, fontWeight: "700" },
        body: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
        section: { gap: 10 },
        label: {
          color: theme.colors.foreground,
          fontSize: 13,
          fontWeight: "700",
        },
        choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
        choice: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 9,
          paddingVertical: 9,
          paddingHorizontal: 14,
        },
        choiceSelected: {
          backgroundColor: theme.colors.accent,
          borderColor: theme.colors.accent,
        },
        choiceText: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" },
        choiceTextSelected: { color: theme.colors.accentForeground },
        input: {
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          borderRadius: 9,
          paddingVertical: 10,
          paddingHorizontal: 12,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface1,
          fontSize: 13,
          fontFamily: "monospace",
        },
        code: {
          color: theme.colors.foregroundMuted,
          backgroundColor: theme.colors.surface1,
          borderRadius: 9,
          padding: 12,
          fontFamily: "monospace",
          fontSize: 12,
        },
        save: {
          alignSelf: "flex-start",
          minWidth: 120,
          minHeight: 40,
          paddingVertical: 10,
          paddingHorizontal: 18,
          borderRadius: 9,
          backgroundColor: theme.colors.accent,
          alignItems: "center",
          justifyContent: "center",
        },
        saveDisabled: { opacity: 0.55 },
        saveText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "700" },
        error: { color: theme.colors.statusDanger, fontSize: 13 },
        divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border },
      }),
    [layout.compact, theme],
  );

  if (query.isPending) {
    return (
      <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const draft: EditorSettings =
    kind === "custom" ? { kind, prefix: customPrefix.trim() } : { kind };
  const canSave = kind !== "custom" || customPrefix.trim().length > 0;
  const desktopExample = desktopRemoteUrl(draft, host.label, "/home/user/project");
  const mobileExample = mobileRemoteUrl(host.label, "/home/user/project");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Icon name="SquareCode" size={24} color={theme.colors.accent} />
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Remote editor</Text>
          <Text style={styles.body}>
            Choose the desktop URI used by every agent pill on {host.label}. The setting is shared
            by clients connected to this Paseo daemon.
          </Text>
        </View>
      </View>

      {query.isError ? (
        <Text style={styles.error}>
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </Text>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.label}>Desktop editor</Text>
        <View style={styles.choices}>
          <Choice label="VS Code" selected={kind === "vscode"} onPress={() => setKind("vscode")} styles={styles} />
          <Choice label="Cursor" selected={kind === "cursor"} onPress={() => setKind("cursor")} styles={styles} />
          <Choice label="Custom" selected={kind === "custom"} onPress={() => setKind("custom")} styles={styles} />
        </View>
        <Text style={styles.body}>
          VS Code uses {VSCODE_REMOTE_PREFIX}; Cursor uses {CURSOR_REMOTE_PREFIX}.
        </Text>
      </View>

      {kind === "custom" ? (
        <View style={styles.section}>
          <Text style={styles.label}>Custom URL prefix</Text>
          <TextInput
            accessibilityLabel="Custom remote editor URL prefix"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="my-editor://remote/ssh+"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={customPrefix}
            onChangeText={setCustomPrefix}
            style={styles.input}
          />
          <Text style={styles.body}>The host name and encoded working directory are appended.</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.label}>Desktop example</Text>
        <Text selectable style={styles.code}>{desktopExample}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save remote editor setting"
        disabled={!canSave || mutation.isPending}
        onPress={() => mutation.mutate(draft)}
        style={[styles.save, !canSave || mutation.isPending ? styles.saveDisabled : null]}
      >
        {mutation.isPending ? (
          <ActivityIndicator color={theme.colors.accentForeground} />
        ) : (
          <Text style={styles.saveText}>Save</Text>
        )}
      </Pressable>

      <View style={styles.divider} />

      <View style={styles.section}>
        <Text style={styles.label}>Mobile</Text>
        <Text style={styles.body}>
          On iOS, Android, and mobile browsers the pill opens vscode.dev through a VS Code tunnel,
          regardless of the desktop editor choice. The tunnel name must match the Paseo host name.
        </Text>
        <Text selectable style={styles.code}>{mobileExample}</Text>
      </View>
    </ScrollView>
  );
}

type Styles = ReturnType<typeof StyleSheet.create>;

function Choice({
  label,
  selected,
  onPress,
  styles,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  styles: Styles;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.choice, selected ? styles.choiceSelected : null]}
    >
      <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>{label}</Text>
    </Pressable>
  );
}
