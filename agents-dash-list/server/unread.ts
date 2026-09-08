import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import {
  UnreadMarksSchema,
  type UnreadMarks,
  type listUnreadMarks,
  type setUnreadMark,
} from "../shared/contracts";
import { paseoHome } from "./paseo-home";

/**
 * "Mark as unread" is the plugin's own state: Paseo has no such flag, so the marks live in the
 * plugin's directory under `$PASEO_HOME` and are shared by every client of this daemon.
 */

const MARK_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

type MarkRecord = Record<string, string>;

/** Every read and write runs in turn, so a concurrent set never loses the other's mark. */
let operations: Promise<unknown> = Promise.resolve();

function enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
  const next = operations.then(operation, operation);
  operations = next.catch(() => undefined);
  return next;
}

/** Resolves once no write is in flight; the plugin entry awaits it while unloading. */
export function flushUnreadWrites(): Promise<void> {
  return operations.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Lists the active marks. `activeWorkspaceIds` is the dashboard's current directory: marks for
 * workspaces that are gone (archived, deleted, moved to another daemon) are dropped here rather
 * than accumulating forever.
 */
export function readUnreadMarks(input: RpcInput<typeof listUnreadMarks>): Promise<UnreadMarks> {
  return enqueue(async () => {
    const pruned = pruneMarks(await loadMarks(), input.activeWorkspaceIds);
    if (pruned.changed) {
      try {
        await persistMarks(pruned.marks);
      } catch (error) {
        // Pruning is housekeeping; a read still answers with the pruned view.
        console.warn("[agents-dash-list] could not prune unread marks", error);
      }
    }
    return { marks: pruned.marks };
  });
}

/** Sets or clears one workspace's mark and answers with the whole updated set. */
export function writeUnreadMark({
  workspaceId,
  unread,
}: RpcInput<typeof setUnreadMark>): Promise<UnreadMarks> {
  return enqueue(async () => {
    const pruned = pruneMarks(await loadMarks(), undefined);
    const marks = pruned.marks;
    let changed = pruned.changed;
    if (unread) {
      marks[workspaceId] = new Date().toISOString();
      changed = true;
    } else if (workspaceId in marks) {
      delete marks[workspaceId];
      changed = true;
    }
    // A failed write is reported: the client tells the user the mark did not stick.
    if (changed) await persistMarks(marks);
    return { marks };
  });
}

function stateDirectory(): string {
  return join(paseoHome(), "plugin-data", "agents-dash-list");
}

function marksPath(): string {
  return join(stateDirectory(), "unread.json");
}

/** A missing or unusable file means "nothing is marked"; it is rewritten on the next change. */
async function loadMarks(): Promise<MarkRecord> {
  const path = marksPath();
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[agents-dash-list] could not read unread marks at ${path}`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // The parse error quotes the file, so only the location is reported.
    console.warn(`[agents-dash-list] ignoring unparsable unread marks at ${path}`);
    return {};
  }
  const marks = UnreadMarksSchema.safeParse(parsed);
  if (!marks.success) {
    console.warn(`[agents-dash-list] ignoring invalid unread marks at ${path}`);
    return {};
  }
  return { ...marks.data.marks };
}

function pruneMarks(
  marks: MarkRecord,
  activeWorkspaceIds: readonly string[] | undefined,
): { marks: MarkRecord; changed: boolean } {
  const active = activeWorkspaceIds ? new Set(activeWorkspaceIds) : null;
  const oldest = Date.now() - MARK_MAX_AGE_MS;
  const kept: MarkRecord = {};
  let changed = false;
  for (const [workspaceId, markedAt] of Object.entries(marks)) {
    const marked = Date.parse(markedAt);
    const stale = !Number.isFinite(marked) || marked < oldest;
    if (stale || (active && !active.has(workspaceId))) {
      changed = true;
      continue;
    }
    kept[workspaceId] = markedAt;
  }
  return { marks: kept, changed };
}

/** Writes through a temporary file so an interrupted write cannot truncate the marks. */
async function persistMarks(marks: MarkRecord): Promise<void> {
  const target = marksPath();
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  try {
    const payload: UnreadMarks = { marks };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
