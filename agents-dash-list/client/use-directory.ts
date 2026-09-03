import type { PaseoAgent, PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Live mirror of one host's workspace and agent directories.
 *
 * The daemon only streams directory updates to a connection that already asked for them, so the
 * hook registers both `subscribe` handlers before seeding and passes `subscribe` on the first
 * page of each paginated `list`. Entries live in refs that are mutated in place; renders are
 * driven by `version`, bumped at most once per event-loop tick so a burst of updates costs one
 * render instead of one render per event.
 */

const PAGE_LIMIT = 200;
/** Ceiling on seed pages so a huge directory cannot spin forever. */
const MAX_PAGES = 10;
const WORKSPACES_SUBSCRIPTION_ID = "agents-dash-list-workspaces";
const AGENTS_SUBSCRIPTION_ID = "agents-dash-list-agents";

export type DashDirectoryStatus = "loading" | "ready" | "error";

/** Status and its message move together, so they live in one state slot. */
interface DirectoryLoadState {
  status: DashDirectoryStatus;
  error: string | null;
  /** False when the seed hit `MAX_PAGES` while the daemon still had more workspaces. */
  complete: boolean;
}

const LOADING_STATE: DirectoryLoadState = { status: "loading", error: null, complete: false };

export interface DashDirectory {
  workspaces: ReadonlyMap<string, PaseoWorkspace>;
  agents: ReadonlyMap<string, PaseoAgent>;
  status: DashDirectoryStatus;
  error: string | null;
  /**
   * True once the workspace seed enumerated the whole directory. Callers that treat the workspace
   * map as a census — the server prunes unread marks against it — must not do so before this.
   */
  complete: boolean;
  /** Changes whenever the maps changed; the map identities stay stable. */
  version: number;
  refresh(): void;
}

/** Local copy of the model's timestamp parser: client-only code should not widen shared/. */
function parseTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not load the workspace directory.";
}

/**
 * Agents without a workspace (or already archived) never render, so they are dropped instead of
 * stored. An upsert older than the snapshot already held is ignored: `list` pages and streamed
 * updates race, and the newest `updatedAt` is the one that should win.
 */
function applyAgent(agents: Map<string, PaseoAgent>, agent: PaseoAgent): void {
  if (agent.archivedAt || !agent.workspaceId) {
    agents.delete(agent.id);
    return;
  }
  const existing = agents.get(agent.id);
  if (existing && parseTime(agent.updatedAt) < parseTime(existing.updatedAt)) return;
  agents.set(agent.id, agent);
}

export function useDashDirectory(paseo: PaseoApi, hostId: string): DashDirectory {
  const workspacesRef = useRef<Map<string, PaseoWorkspace>>(new Map());
  const agentsRef = useRef<Map<string, PaseoAgent>>(new Map());
  const bumpScheduledRef = useRef(false);
  const mountedRef = useRef(true);

  const [version, setVersion] = useState(0);
  const [load, setLoad] = useState(LOADING_STATE);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const scheduleBump = useCallback(() => {
    if (bumpScheduledRef.current) return;
    bumpScheduledRef.current = true;
    void Promise.resolve().then(() => {
      bumpScheduledRef.current = false;
      if (!mountedRef.current) return;
      setVersion((current) => current + 1);
    });
  }, []);

  const refresh = useCallback(() => {
    setReloadToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    const workspaces = new Map<string, PaseoWorkspace>();
    const agents = new Map<string, PaseoAgent>();
    workspacesRef.current = workspaces;
    agentsRef.current = agents;
    setLoad(LOADING_STATE);
    scheduleBump();

    const unsubscribeWorkspaces = paseo.workspaces.subscribe((update) => {
      if (stopped) return;
      if (update.kind === "upsert") {
        workspaces.set(update.workspace.id, update.workspace);
      } else {
        workspaces.delete(update.id);
      }
      scheduleBump();
    });

    const unsubscribeAgents = paseo.agents.subscribe((update) => {
      if (stopped) return;
      if (update.kind === "upsert") {
        applyAgent(agents, update.agent);
      } else {
        agents.delete(update.agentId);
      }
      scheduleBump();
    });

    /** Resolves to whether every page landed; a truncated seed is not a census. */
    const seedWorkspaces = async (): Promise<boolean> => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await paseo.workspaces.list({
          sort: [{ key: "activity_at", direction: "desc" }],
          page: { limit: PAGE_LIMIT, cursor },
          ...(page === 0
            ? { subscribe: { subscriptionId: WORKSPACES_SUBSCRIPTION_ID } }
            : {}),
        });
        if (stopped) return false;
        for (const workspace of result.entries) {
          // A streamed update that landed mid-seed is newer than this snapshot page.
          if (!workspaces.has(workspace.id)) workspaces.set(workspace.id, workspace);
        }
        scheduleBump();
        const nextCursor = result.pageInfo.nextCursor;
        if (!result.pageInfo.hasMore || !nextCursor) return true;
        cursor = nextCursor;
      }
      return false;
    };

    const seedAgents = async () => {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await paseo.agents.list({
          filter: { includeArchived: false },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: PAGE_LIMIT, cursor },
          ...(page === 0 ? { subscribe: { subscriptionId: AGENTS_SUBSCRIPTION_ID } } : {}),
        });
        if (stopped) return;
        for (const entry of result.entries) {
          applyAgent(agents, entry.agent);
        }
        scheduleBump();
        const nextCursor = result.pageInfo.nextCursor;
        if (!result.pageInfo.hasMore || !nextCursor) return;
        cursor = nextCursor;
      }
    };

    void (async () => {
      try {
        const complete = await seedWorkspaces();
        await seedAgents();
        if (stopped) return;
        setLoad({ status: "ready", error: null, complete });
        scheduleBump();
      } catch (cause) {
        if (stopped) return;
        setLoad({ status: "error", error: errorMessage(cause), complete: false });
      }
    })();

    return () => {
      stopped = true;
      unsubscribeWorkspaces();
      unsubscribeAgents();
    };
  }, [paseo, hostId, reloadToken, scheduleBump]);

  return useMemo(
    () => ({
      workspaces: workspacesRef.current,
      agents: agentsRef.current,
      status: load.status,
      error: load.error,
      complete: load.complete,
      version,
      refresh,
    }),
    [load, version, refresh],
  );
}
