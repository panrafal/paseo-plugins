import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DEFAULT_EDITOR_SETTINGS,
  type EditorSettings,
} from "./editor";

export {
  CURSOR_REMOTE_PREFIX,
  DEFAULT_EDITOR_SETTINGS,
  VSCODE_REMOTE_PREFIX,
  desktopPrefix,
  editorName,
  type EditorKind,
  type EditorSettings,
} from "./editor";

export const CustomPrefixSchema = z
  .string()
  .trim()
  .min(1, "Enter a URL prefix.")
  .max(2_048, "The URL prefix is too long.")
  .regex(/^[a-z][a-z0-9+.-]*:\/\/\S*$/i, "Use a URL prefix such as my-editor://remote/ssh+");

export const EditorSettingsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("vscode") }),
  z.object({ kind: z.literal("cursor") }),
  z.object({ kind: z.literal("custom"), prefix: CustomPrefixSchema }),
]);

const EmptyInputSchema = z.object({});

export const getEditorSettings = defineRpc({
  name: "vscode-open-remote.settings.get",
  input: EmptyInputSchema,
  output: EditorSettingsSchema,
});

export const setEditorSettings = defineRpc({
  name: "vscode-open-remote.settings.set",
  input: EditorSettingsSchema,
  output: EditorSettingsSchema,
});
