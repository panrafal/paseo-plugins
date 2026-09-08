import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { findTask, taskUrl, type TaskLinkSettings } from "../shared/link";
import { getTaskLinkSettings, setTaskLinkSettings, TaskLinkSettingsSchema } from "../shared/settings";

const QUERY_KEY = ["task-link", "settings"] as const;
type Props = PluginSurfaceProps & { onSaved(settings: TaskLinkSettings): void };

export function SettingsSurface(props: Props) {
  const getSettings = useRpc(getTaskLinkSettings);
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => getSettings({}) });
  if (query.isPending) return <Text style={{ color: props.theme.colors.foreground }}>Loading settings…</Text>;
  if (query.isError) return (
    <SettingsSection title="Task link">
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>{query.error.message}</Text>
      <SettingsAction label="Load settings" actionLabel="Retry" onPress={() => { void query.refetch(); }} />
    </SettingsSection>
  );
  return <SettingsEditor {...props} initialSettings={query.data} />;
}

function SettingsEditor({ theme, host, initialSettings, onSaved }: Props & { initialSettings: TaskLinkSettings }) {
  const [draft, setDraft] = useState(initialSettings);
  const [sample, setSample] = useState("feature/CT-1234-fix");
  const saveSettings = useRpc(setTaskLinkSettings);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (settings: TaskLinkSettings) => saveSettings(settings),
    onSuccess(settings) {
      queryClient.setQueryData(QUERY_KEY, settings);
      onSaved(settings);
      toast.show("Task link saved", { variant: "success" });
    },
  });
  const parsed = TaskLinkSettingsSchema.safeParse(draft);
  const fieldError = (field: keyof TaskLinkSettings) => parsed.success ? null
    : parsed.error.issues.find((issue) => issue.path[0] === field)?.message;
  const task = fieldError("pattern") ? null : findTask(sample, draft.pattern);
  const url = task && parsed.success ? taskUrl(task, parsed.data.urlTemplate) : null;

  return (
    <SettingsSection title="Task link">
      <SettingsCard>
        <SettingsInput
          label="Task regular expression"
          hint="Use a JavaScript pattern without / delimiters. The first non-empty capture group is the ID; without groups, the full match is used. Matching is case-sensitive."
          initialValue={draft.pattern}
          onChangeText={(pattern) => setDraft((current) => ({ ...current, pattern }))}
          disabled={mutation.isPending}
          error={fieldError("pattern")}
        />
        <SettingsInput
          label="Task link"
          hint="Use an HTTP or HTTPS link with {ID}. The captured ID is URL-encoded and replaces every {ID}."
          initialValue={draft.urlTemplate}
          onChangeText={(urlTemplate) => setDraft((current) => ({ ...current, urlTemplate }))}
          disabled={mutation.isPending}
          error={fieldError("urlTemplate")}
        />
        <SettingsAction
          label="Save task link"
          hint={`Applies to agents on ${host.label}.`}
          actionLabel={mutation.isPending ? "Saving…" : "Save"}
          disabled={!parsed.success || mutation.isPending}
          error={mutation.error?.message}
          onPress={() => { if (parsed.success) mutation.mutate(parsed.data); }}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsInput label="Try a branch or title" initialValue={sample} onChangeText={setSample} />
        <SettingsRow label="Extracted task ID">
          <Text selectable style={{ color: theme.colors.foreground }}>{task ?? "No match"}</Text>
        </SettingsRow>
        <SettingsRow label="Link preview">
          <Text selectable style={{ color: theme.colors.foregroundMuted }}>{url ?? "Enter a matching task and valid link."}</Text>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
