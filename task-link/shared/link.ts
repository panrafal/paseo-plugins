export const DEFAULT_TASK_LINK_SETTINGS = {
  pattern: "\\b([Cc][Tt]-\\d+)\\b",
  urlTemplate: "https://www.notion.so/{ID}",
};

export type TaskLinkSettings = typeof DEFAULT_TASK_LINK_SETTINGS;

/** Capture groups take precedence; use the full match only if there are no groups. */
export function findTask(text: string | null | undefined, pattern: string): string | null {
  if (!text) return null;
  // matchAll advances past empty matches, including alternatives with empty captures.
  for (const match of text.matchAll(new RegExp(pattern, "g"))) {
    const candidates = match.length > 1 ? match.slice(1) : [match[0]];
    const task = candidates.find((candidate) => candidate !== undefined && candidate.length > 0);
    if (task) return task;
  }
  return null;
}

export function findTaskIn(
  pattern: string,
  ...texts: ReadonlyArray<string | null | undefined>
): string | null {
  for (const text of texts) {
    const task = findTask(text, pattern);
    if (task) return task;
  }
  return null;
}

export function taskUrl(task: string, urlTemplate: string): string {
  return urlTemplate.replaceAll("{ID}", encodeURIComponent(task));
}
