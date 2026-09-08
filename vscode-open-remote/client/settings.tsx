import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import {
  CURSOR_REMOTE_PREFIX,
  type EditorKind,
  type EditorSettings,
  EditorSettingsSchema,
  VSCODE_REMOTE_PREFIX,
  getEditorSettings,
  setEditorSettings,
} from "../shared/settings";
import { desktopRemoteUrl, mobileRemoteUrl } from "../shared/url";

const SETTINGS_QUERY_KEY = ["vscode-open-remote", "settings"] as const;
const EDITORS = [
  { label: "VS Code", value: "vscode" },
  { label: "Cursor", value: "cursor" },
  { label: "Custom", value: "custom" },
] as const;

export function SettingsSurface(props: PluginSurfaceProps) {
  const getSettings = useRpc(getEditorSettings);
  const query = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => getSettings({}),
  });
  if (query.isPending) return <Text style={{ color: props.theme.colors.foreground }}>Loading settings…</Text>;
  if (query.isError) return (
    <SettingsSection title="Remote editor">
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>{query.error.message}</Text>
      <SettingsAction label="Load settings" actionLabel="Retry" onPress={() => { void query.refetch(); }} />
    </SettingsSection>
  );
  return <EditorSettingsForm {...props} initialSettings={query.data} />;
}

function EditorSettingsForm({ theme, host, initialSettings }: PluginSurfaceProps & { initialSettings: EditorSettings }) {
  const [kind, setKind] = useState<EditorKind>(initialSettings.kind);
  const [customPrefix, setCustomPrefix] = useState(initialSettings.kind === "custom" ? initialSettings.prefix : "");
  const saveSettings = useRpc(setEditorSettings);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (settings: EditorSettings) => saveSettings(settings),
    onSuccess(settings) {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, settings);
      toast.show("Remote editor saved", { variant: "success" });
    },
  });
  const draft: EditorSettings = kind === "custom" ? { kind, prefix: customPrefix.trim() } : { kind };
  const parsed = EditorSettingsSchema.safeParse(draft);
  const desktopExample = parsed.success ? desktopRemoteUrl(parsed.data, host.label, "/home/user/project") : null;
  const mobileExample = mobileRemoteUrl(host.label, "/home/user/project");

  return (
    <>
      <SettingsSection title="Desktop editor">
        <SettingsCard>
          <SettingsSelect<EditorKind>
            label="Editor"
            hint={`Used by agent pills on ${host.label}. VS Code uses ${VSCODE_REMOTE_PREFIX}; Cursor uses ${CURSOR_REMOTE_PREFIX}.`}
            value={kind}
            options={EDITORS}
            onValueChange={setKind}
            disabled={mutation.isPending}
          />
          {kind === "custom" ? (
            <SettingsInput
              label="Custom URL prefix"
              hint="The host name and encoded working directory are appended."
              initialValue={customPrefix}
              onChangeText={setCustomPrefix}
              placeholder="my-editor://remote/ssh+"
              disabled={mutation.isPending}
              error={parsed.success ? null : parsed.error.issues[0]?.message}
            />
          ) : null}
          <SettingsRow label="Desktop example">
            <Text selectable style={{ color: theme.colors.foregroundMuted }}>{desktopExample ?? "Enter a valid URL prefix."}</Text>
          </SettingsRow>
          <SettingsAction
            label="Save remote editor"
            actionLabel={mutation.isPending ? "Saving…" : "Save"}
            disabled={!parsed.success || mutation.isPending}
            error={mutation.error?.message}
            onPress={() => { if (parsed.success) mutation.mutate(parsed.data); }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Mobile">
        <SettingsCard>
          <SettingsRow label="Tablets" hint="The pill opens vscode.dev through a VS Code tunnel, regardless of the desktop editor. Its tunnel name must match the Paseo host name. The pill is hidden on phones.">
            <Text selectable style={{ color: theme.colors.foregroundMuted }}>{mobileExample}</Text>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
