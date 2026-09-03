import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EDITOR_SETTINGS,
  EditorSettingsSchema,
  type EditorSettings,
} from "../shared/settings";

function settingsDirectory(): string {
  const paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "vscode-open-remote");
}

function settingsPath(): string {
  return join(settingsDirectory(), "settings.json");
}

/** Invalid or missing settings should never stop the plugin from loading. */
export async function readEditorSettings(): Promise<EditorSettings> {
  try {
    const parsed = EditorSettingsSchema.safeParse(JSON.parse(await readFile(settingsPath(), "utf8")));
    if (parsed.success) return parsed.data;
    console.warn("[vscode-open-remote] ignoring invalid settings", parsed.error.message);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn("[vscode-open-remote] could not read settings", error);
    }
  }
  return DEFAULT_EDITOR_SETTINGS;
}

/** Persist one editor choice for every client connected to this Paseo daemon. */
export async function writeEditorSettings(settings: EditorSettings): Promise<EditorSettings> {
  const normalized = EditorSettingsSchema.parse(settings);
  await mkdir(settingsDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(settingsPath(), `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return normalized;
}
