import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
} from "@getpaseo/plugin";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import React, { useMemo } from "react";
import { Linking, Text } from "react-native";
import { findTaskIn, getBranch, notionTaskUrl } from "../shared/task";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "capitally-tasks-agents";
const WORKSPACE_SUBSCRIPTION_ID = "capitally-tasks-workspaces";

/**
 * Paseo owns the pressable and the pill chrome; this renders only the icon and
 * the task number inside it.
 */
function TaskPill({ theme, task }: PluginComposerPillProps & { task: string }) {
  const style = useMemo(
    () => ({ color: theme.colors.foregroundMuted, flexShrink: 1 }),
    [theme],
  );
  return (
    <>
      <Icon name="SquareKanban" size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={style}>
        {task}
      </Text>
    </>
  );
}

/**
 * `Linking.openURL` is `window.open` on the desktop renderer, which lands in a
 * bare child window. The desktop preload exposes the opener Paseo's own links
 * use; mobile and plain web keep `Linking`, which already opens a browser tab.
 */
interface DesktopOpenerBridge {
  readonly opener?: { readonly openUrl?: (url: string) => Promise<void> };
}

async function openExternalUrl(url: string): Promise<void> {
  const openUrl = (globalThis as { paseoDesktop?: DesktopOpenerBridge }).paseoDesktop?.opener
    ?.openUrl;
  if (typeof openUrl === "function") {
    try {
      await openUrl(url);
      return;
    } catch (error) {
      console.warn("[capitally-tasks] desktop opener refused the URL, falling back", error);
    }
  }
  await Linking.openURL(url);
}

type AgentState = {
  workspaceId: string;
  cwd: string;
  title: string | null;
  status: PaseoAgent["status"];
  /** Task the current pill was registered for; `null` when there is no pill. */
  task: string | null;
  removePill: (() => void) | null;
};

type WorkspaceNames = { name: string; title: string | null };

/**
 * One pill per agent whose branch, workspace name, or task title references a
 * Capitally task. The client entry runs once per installation per connected
 * app, so this owns the whole set: it seeds from the agents and workspaces that
 * already exist, follows both update streams, refreshes the git branch on the
 * daemon when an agent finishes a turn, and hands every pill back on teardown.
 */
export function contributeClient(client: PluginClientContext) {
  const agents = new Map<string, AgentState>();
  const workspaces = new Map<string, WorkspaceNames>();
  /** Branch per directory. Missing means unknown; `null` means no branch. */
  const branches = new Map<string, string | null>();
  const branchLookups = new Set<string>();
  let stopped = false;

  function resolveTask(state: AgentState): string | null {
    const workspace = workspaces.get(state.workspaceId);
    return findTaskIn(
      branches.get(state.cwd),
      state.title,
      workspace?.title,
      workspace?.name,
    );
  }

  function dropPill(state: AgentState) {
    state.removePill?.();
    state.removePill = null;
    state.task = null;
  }

  /** Re-registers the pill only when the task or workspace changes. */
  function sync(agentId: string) {
    const state = agents.get(agentId);
    if (!state || stopped) return;
    const task = resolveTask(state);
    if (task === state.task) return;
    dropPill(state);
    if (!task) return;
    const { workspaceId } = state;
    const url = notionTaskUrl(task);
    const Component = (props: PluginComposerPillProps) => <TaskPill {...props} task={task} />;
    state.task = task;
    state.removePill = client.addComposerPill({
      id: "capitally-task",
      title: `Open ${task} in Notion`,
      workspaceId,
      agentId,
      Component,
      onPress: () => openExternalUrl(url),
    });
  }

  function syncDirectory(directory: string) {
    for (const [agentId, state] of agents) {
      if (state.cwd === directory) sync(agentId);
    }
  }

  function syncWorkspace(workspaceId: string) {
    for (const [agentId, state] of agents) {
      if (state.workspaceId === workspaceId) sync(agentId);
    }
  }

  function refreshBranch(directory: string) {
    if (stopped || branchLookups.has(directory)) return;
    branchLookups.add(directory);
    client
      .rpc(getBranch, { directory })
      .then(({ branch }) => {
        if (stopped) return;
        const previous = branches.get(directory);
        branches.set(directory, branch);
        if (previous !== branch) syncDirectory(directory);
      })
      .catch((error: unknown) => {
        console.error("[capitally-tasks] branch lookup failed", directory, error);
      })
      .finally(() => {
        branchLookups.delete(directory);
      });
  }

  function remove(agentId: string) {
    const state = agents.get(agentId);
    if (!state) return;
    dropPill(state);
    agents.delete(agentId);
  }

  function register(agent: PaseoAgent) {
    if (stopped || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    const previous = agents.get(agent.id);
    const state: AgentState = {
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      title: agent.title ?? null,
      status: agent.status,
      task: previous?.task ?? null,
      removePill: previous?.removePill ?? null,
    };
    agents.set(agent.id, state);
    // The pill belongs to a workspace track, so a moved agent needs a new one.
    if (previous && previous.workspaceId !== agent.workspaceId) dropPill(state);

    // A finished turn may have switched branches, and a new directory has no
    // cached branch yet. Anything else is a status blip that cannot change git.
    const finishedTurn = previous?.status === "running" && agent.status !== "running";
    if (!branches.has(agent.cwd) || finishedTurn) refreshBranch(agent.cwd);
    sync(agent.id);
  }

  function rememberWorkspace(workspace: PaseoWorkspace) {
    workspaces.set(workspace.id, { name: workspace.name, title: workspace.title ?? null });
    syncWorkspace(workspace.id);
  }

  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else register(update.agent);
  });

  const unsubscribeWorkspaces = client.paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") rememberWorkspace(update.workspace);
  });

  // `subscribe` only reports change. Without seeding, an agent already sitting
  // idle when the app connected would have no pill until it next did something.
  void seedWorkspaces(client).then((entries) => {
    if (stopped) return;
    for (const workspace of entries) rememberWorkspace(workspace);
    return seedAgents(client, register);
  });

  return () => {
    stopped = true;
    unsubscribeAgents();
    unsubscribeWorkspaces();
    for (const agentId of [...agents.keys()]) remove(agentId);
    workspaces.clear();
    branches.clear();
  };
}

async function seedWorkspaces(client: PluginClientContext) {
  try {
    const result = await client.paseo.workspaces.list({
      subscribe: { subscriptionId: WORKSPACE_SUBSCRIPTION_ID },
    });
    return result.entries;
  } catch (error) {
    console.error("[capitally-tasks] could not list workspaces", error);
    return [];
  }
}

async function seedAgents(client: PluginClientContext, register: (agent: PaseoAgent) => void) {
  try {
    let cursor: string | undefined;
    do {
      const response = await client.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
      });
      for (const { agent } of response.entries) register(agent);
      cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } catch (error) {
    console.error("[capitally-tasks] could not list agents", error);
  }
}
