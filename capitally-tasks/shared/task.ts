import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Matches a Capitally task reference such as `CT-1393` or `ct-42`, as a whole word. */
export const TASK_PATTERN = /\bct-[0-9]+\b/i;

export const NOTION_BASE_URL = "https://www.notion.so/";

/** Returns the first Capitally task reference in `text`, normalised to uppercase. */
export function findTask(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = TASK_PATTERN.exec(text);
  return match ? match[0].toUpperCase() : null;
}

/** Returns the first Capitally task reference found across `texts`, in order. */
export function findTaskIn(...texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const text of texts) {
    const task = findTask(text);
    if (task) return task;
  }
  return null;
}

/** Notion opens `https://www.notion.so/CT-1393` straight onto the task page. */
export function notionTaskUrl(task: string): string {
  return `${NOTION_BASE_URL}${task.toUpperCase()}`;
}

/**
 * Reads the checked-out branch of a directory on the daemon machine. The client
 * never sees the filesystem, so the lookup has to run beside the daemon.
 */
export const getBranch = defineRpc({
  name: "capitally.branch",
  input: z.object({ directory: z.string().min(1) }),
  output: z.object({ branch: z.string().nullable() }),
});
