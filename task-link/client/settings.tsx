import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import {
  DEFAULT_TASK_LINK_RULE,
  findTask,
  taskLabel,
  taskUrl,
  type TaskLinkRule,
  type TaskLinkSettings,
} from "../shared/link";
import { getTaskLinkSettings, setTaskLinkSettings, TaskLinkSettingsSchema } from "../shared/settings";

const QUERY_KEY = ["task-link", "settings"] as const;
type Props = PluginSurfaceProps & { onSaved(settings: TaskLinkSettings): void };
/** Inputs are uncontrolled, so each link needs a stable key across removals. */
type DraftLink = TaskLinkRule & { key: number };

let nextKey = 0;
const toDraft = (link: TaskLinkRule): DraftLink => ({ ...link, key: nextKey++ });

export function SettingsSurface(props: Props) {
  const getSettings = useRpc(getTaskLinkSettings);
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => getSettings({}) });
  if (query.isPending) return <Text style={{ color: props.theme.colors.foreground }}>Loading settings…</Text>;
  if (query.isError) return (
    <SettingsSection title="Task links">
      <Text accessibilityRole="alert" style={{ color: props.theme.colors.statusDanger }}>{query.error.message}</Text>
      <SettingsAction label="Load settings" actionLabel="Retry" onPress={() => { void query.refetch(); }} />
    </SettingsSection>
  );
  return <SettingsEditor {...props} initialSettings={query.data} />;
}

function SettingsEditor({ theme, host, initialSettings, onSaved }: Props & { initialSettings: TaskLinkSettings }) {
  const [draft, setDraft] = useState(() => initialSettings.links.map(toDraft));
  const [sample, setSample] = useState("feature/CT-1234-fix");
  const saveSettings = useRpc(setTaskLinkSettings);
  const queryClient = useQueryClient();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: (settings: TaskLinkSettings) => saveSettings(settings),
    onSuccess(settings) {
      queryClient.setQueryData(QUERY_KEY, settings);
      onSaved(settings);
      toast.show("Task links saved", { variant: "success" });
    },
  });
  const links: TaskLinkRule[] = draft.map(({ key: _key, label, ...link }) =>
    label?.trim() ? { ...link, label } : link);
  const parsed = TaskLinkSettingsSchema.safeParse({ links });
  const fieldError = (index: number, field: keyof TaskLinkRule) => parsed.success ? null
    : parsed.error.issues.find((issue) => issue.path[1] === index && issue.path[2] === field)?.message;
  const update = (key: number, patch: Partial<TaskLinkRule>) =>
    setDraft((current) => current.map((link) => link.key === key ? { ...link, ...patch } : link));

  return (
    <>
      <SettingsSection title="Task links">
        {draft.map((link, index) => (
          <SettingsCard key={link.key}>
            <SettingsInput
              label="Task regular expression"
              hint="Use a JavaScript pattern without / delimiters. The first non-empty capture group is the ID; without groups, the full match is used. Matching is case-sensitive."
              initialValue={link.pattern}
              onChangeText={(pattern) => update(link.key, { pattern })}
              disabled={mutation.isPending}
              error={fieldError(index, "pattern")}
            />
            <SettingsInput
              label="Task link"
              hint="Use an HTTP or HTTPS link with {ID}. The captured ID is URL-encoded and replaces every {ID}."
              initialValue={link.urlTemplate}
              onChangeText={(urlTemplate) => update(link.key, { urlTemplate })}
              disabled={mutation.isPending}
              error={fieldError(index, "urlTemplate")}
            />
            <SettingsInput
              label="Pill label"
              hint="Optional. Shown on the pill instead of the task ID; {ID} is replaced with the ID."
              placeholder="Task ID"
              initialValue={link.label ?? ""}
              onChangeText={(label) => update(link.key, { label })}
              disabled={mutation.isPending}
              error={fieldError(index, "label")}
            />
            <SettingsAction
              label={`Link ${index + 1}`}
              actionLabel="Remove"
              disabled={mutation.isPending}
              onPress={() => setDraft((current) => current.filter((item) => item.key !== link.key))}
            />
          </SettingsCard>
        ))}
        <SettingsCard>
          <SettingsAction
            label="Add a link"
            hint="Each link that matches shows its own pill."
            actionLabel="Add"
            disabled={mutation.isPending}
            onPress={() => setDraft((current) => [...current, toDraft(DEFAULT_TASK_LINK_RULE)])}
          />
          <SettingsAction
            label="Save task links"
            hint={`Applies to agents on ${host.label}.`}
            actionLabel={mutation.isPending ? "Saving…" : "Save"}
            disabled={!parsed.success || mutation.isPending}
            error={mutation.error?.message ?? (parsed.success ? null : rootError(parsed.error.issues))}
            onPress={() => { if (parsed.success) mutation.mutate(parsed.data); }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Preview">
        <SettingsCard>
          <SettingsInput label="Try a branch or title" initialValue={sample} onChangeText={setSample} />
        </SettingsCard>
        {links.map((link, index) => {
          const task = fieldError(index, "pattern") ? null : findTask(sample, link.pattern);
          const url = task && !fieldError(index, "urlTemplate") ? taskUrl(task, link.urlTemplate) : null;
          return (
            <SettingsCard key={draft[index].key}>
              <SettingsRow label={`Link ${index + 1} pill`}>
                <Text selectable style={{ color: theme.colors.foreground }}>
                  {task ? taskLabel(task, link.label) : "No match"}
                </Text>
              </SettingsRow>
              <SettingsRow label="Link preview">
                <Text selectable style={{ color: theme.colors.foregroundMuted }}>{url ?? "Enter a matching task and valid link."}</Text>
              </SettingsRow>
            </SettingsCard>
          );
        })}
      </SettingsSection>
    </>
  );
}

function rootError(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string | null {
  return issues.find((issue) => issue.path.length <= 1)?.message ?? null;
}
