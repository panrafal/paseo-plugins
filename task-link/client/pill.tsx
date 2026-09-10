import { type PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import React from "react";
import { Linking } from "react-native";
import { getBranch } from "../shared/task";
import { findTaskIn, taskUrl, type TaskLinkSettings } from "../shared/link";
import { getTaskLinkSettings } from "../shared/settings";
import { SettingsSurface } from "./settings";
import { openDesktopUrl } from "./web";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "task-link-agents";
const WORKSPACE_SUBSCRIPTION_ID = "task-link-workspaces";

async function openExternalUrl(url: string): Promise<void> {
  if (await openDesktopUrl(url)) return;
  await Linking.openURL(url);
}

type AgentState = {
  workspaceId: string;
  cwd: string;
  title: string | null;
  status: PaseoAgent["status"];
  /** Task the current pill was registered for; `null` when there is no pill. */
  task: string | null;
  url: string | null;
  removePill: (() => void) | null;
};

type WorkspaceNames = { name: string; title: string | null };

/**
 * One pill per agent whose branch, workspace name, or task title references a
 * task. The client entry runs once per installation per connected
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
  let settings: TaskLinkSettings | null = null;
  let settingsRequest = 0;

  function applySettings(next: TaskLinkSettings) {
    if (stopped) return;
    // Invalidate reads started before a local save completed.
    settingsRequest++;
    settings = next;
    for (const agentId of agents.keys()) sync(agentId);
  }

  async function refreshSettings() {
    const request = ++settingsRequest;
    try {
      const next = await client.rpc(getTaskLinkSettings, {});
      if (!stopped && request === settingsRequest) applySettings(next);
    } catch (error) {
      console.error("[task-link] could not load settings", error);
    }
  }

  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: "Task link",
    icon: "Link",
    Component: (props) => <SettingsSurface {...props} onSaved={applySettings} />,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "configure-task-link",
    title: "Configure task link",
    icon: "Link",
    keywords: ["task", "regex", "link"],
    context: "global",
    onSelect({ openSettings }) { openSettings("settings"); },
  });
  void refreshSettings();
  const settingsTimer = setInterval(() => { void refreshSettings(); }, 15_000);

  function resolveTask(state: AgentState): string | null {
    if (!settings) return null;
    const workspace = workspaces.get(state.workspaceId);
    return findTaskIn(
      settings.pattern,
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
    state.url = null;
  }

  /** Re-registers when the task, URL, or workspace changes. */
  function sync(agentId: string) {
    const state = agents.get(agentId);
    if (!state || stopped) return;
    const task = resolveTask(state);
    const url = task && settings ? taskUrl(task, settings.urlTemplate) : null;
    if (task === state.task && url === state.url) return;
    dropPill(state);
    if (!task || !url) return;
    const { workspaceId } = state;
    state.task = task;
    state.url = url;
    const registration = client.addComposerPill({
      id: "task-link",
      workspaceId,
      agentId,
      button: {
        title: `Open task ${task}`,
        icon: "SquareKanban",
        label: task,
        behavior: {
          kind: "action",
          async onPress() {
            // Read on press as well so another client's save cannot open a stale link.
            const next = await client.rpc(getTaskLinkSettings, {});
            applySettings(next);
            const current = agents.get(agentId);
            if (!stopped && current?.url) await openExternalUrl(current.url);
          },
        },
      },
    });
    state.removePill = () => registration.remove();
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
        console.error("[task-link] branch lookup failed", directory, error);
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
      url: previous?.url ?? null,
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
    clearInterval(settingsTimer);
    removeSettings();
    removeCommand();
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
    console.error("[task-link] could not list workspaces", error);
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
    console.error("[task-link] could not list agents", error);
  }
}
