export const VSCODE_REMOTE_PREFIX = "vscode://vscode-remote/ssh-remote+";
export const CURSOR_REMOTE_PREFIX = "cursor://vscode-remote/ssh-remote+";

export type EditorSettings =
  | { kind: "vscode" }
  | { kind: "cursor" }
  | { kind: "custom"; prefix: string };

export type EditorKind = EditorSettings["kind"];

export const DEFAULT_EDITOR_SETTINGS = { kind: "vscode" } as const satisfies EditorSettings;

export function desktopPrefix(settings: EditorSettings): string {
  if (settings.kind === "cursor") return CURSOR_REMOTE_PREFIX;
  if (settings.kind === "custom") return settings.prefix;
  return VSCODE_REMOTE_PREFIX;
}

export function editorName(settings: EditorSettings): string {
  if (settings.kind === "cursor") return "Cursor";
  if (settings.kind === "custom") return "custom editor";
  return "VS Code";
}
