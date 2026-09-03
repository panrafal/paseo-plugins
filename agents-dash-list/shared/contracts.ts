import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The ten label colors Paseo's workspace-label catalog can assign. */
export const WORKSPACE_LABEL_COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type WorkspaceLabelColor = (typeof WORKSPACE_LABEL_COLORS)[number];

export const LabelDefinitionSchema = z.object({
  name: z.string().min(1),
  color: z.enum(WORKSPACE_LABEL_COLORS),
});

export type LabelDefinition = z.infer<typeof LabelDefinitionSchema>;

export const DecorationProjectInputSchema = z.object({
  projectId: z.string().min(1),
  /** Absolute project root on the daemon machine; automatic icons are discovered here. */
  rootPath: z.string().min(1),
  /** Non-null when the user uploaded a custom icon in Paseo; identifies the stored bytes. */
  customIconRevision: z.string().nullable(),
});

export type DecorationProjectInput = z.infer<typeof DecorationProjectInputSchema>;

export const DecorationsSchema = z.object({
  /** Project ID to a `data:` URI, or `null` when no icon could be found. */
  icons: z.record(z.string(), z.string().nullable()),
  /** The daemon's label catalog, so label chips render in their configured colors. */
  labels: z.array(LabelDefinitionSchema),
});

export type Decorations = z.infer<typeof DecorationsSchema>;

/**
 * Project icons and the label catalog live on the daemon machine. The plugin SDK does not
 * expose them, so the server entry reads them from disk on the client's behalf.
 */
export const getDecorations = defineRpc({
  name: "agents-dash-list.decorations.get",
  input: z.object({ projects: z.array(DecorationProjectInputSchema).max(500) }),
  output: DecorationsSchema,
});

/** Workspace ID to the ISO timestamp at which the user marked it unread. */
export const UnreadMarksSchema = z.object({
  marks: z.record(z.string(), z.string()),
});

export type UnreadMarks = z.infer<typeof UnreadMarksSchema>;

/**
 * Lists the plugin-owned "mark as unread" flags. When `activeWorkspaceIds` is supplied, marks
 * for workspaces no longer in that set are dropped so archived workspaces do not accumulate.
 */
export const listUnreadMarks = defineRpc({
  name: "agents-dash-list.unread.list",
  input: z.object({ activeWorkspaceIds: z.array(z.string().min(1)).max(2000).optional() }),
  output: UnreadMarksSchema,
});

export const setUnreadMark = defineRpc({
  name: "agents-dash-list.unread.set",
  input: z.object({ workspaceId: z.string().min(1), unread: z.boolean() }),
  output: UnreadMarksSchema,
});
