import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TASK_LINK_SETTINGS,
  TaskLinkSettingsSchema,
  type TaskLinkSettings,
} from "../shared/settings";

function settingsDirectory(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "task-link");
}

export async function readTaskLinkSettings(): Promise<TaskLinkSettings> {
  try {
    return TaskLinkSettingsSchema.parse(
      JSON.parse(await readFile(join(settingsDirectory(), "settings.json"), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TASK_LINK_SETTINGS;
    throw error;
  }
}

export async function writeTaskLinkSettings(settings: TaskLinkSettings): Promise<TaskLinkSettings> {
  const normalized = TaskLinkSettingsSchema.parse(settings);
  const directory = settingsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `settings.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(directory, "settings.json"));
  } finally {
    await rm(temporary, { force: true });
  }
  return normalized;
}
