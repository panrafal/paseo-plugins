import { type PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import React from "react";
import { Linking } from "react-native";
import { getBranch } from "../shared/task";
import { findTaskIn, taskLabel, taskUrl, type TaskLinkSettings } from "../shared/link";
import { getTaskLinkSettings } from "../shared/settings";
import { createSubscriptionKeeper, type SubscriptionKeeper } from "./directory-subscription";
import { SettingsSurface } from "./settings";
import { openDesktopUrl } from "./web";

const AGENT_PAGE_SIZE = 200;

async function openExternalUrl(url: string): Promise<void> {
  if (await openDesktopUrl(url)) return;
  await Linking.openURL(url);
}

type AgentState = {
  workspaceId: string;
  cwd: string;
  title: string | null;
  status: PaseoAgent["status"];
  /** Registered pills by link index; empty where a link has no match. */
  pills: Array<Pill | undefined>;
};

type Pill = { task: string; label: string; url: string; remove: () => void };

/** The first link keeps the original pill ID. */
function pillId(index: number): string {
  return index === 0 ? "task-link" : `task-link-${index + 1}`;
}

type WorkspaceNames = { name: string; title: string | null };

/**
 * One pill per configured link per agent whose branch, workspace name, or task title references a
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

  /** Removes the pills of links at `from` and beyond. */
  function dropPills(state: AgentState, from = 0) {
    for (const pill of state.pills.slice(from)) pill?.remove();
    state.pills.length = Math.min(state.pills.length, from);
  }

  /** Re-registers each link's pill when its task, label, or URL changes. */
  function sync(agentId: string) {
    const state = agents.get(agentId);
    if (!state || stopped || !settings) return;
    const workspace = workspaces.get(state.workspaceId);
    const texts = [branches.get(state.cwd), state.title, workspace?.title, workspace?.name];
    const { links } = settings;
    dropPills(state, links.length);
    links.forEach((link, index) => {
      const task = findTaskIn(link.pattern, ...texts);
      const label = task ? taskLabel(task, link.label) : null;
      const url = task ? taskUrl(task, link.urlTemplate) : null;
      const previous = state.pills[index];
      if (previous?.task === task && previous.label === label && previous.url === url) return;
      previous?.remove();
      state.pills[index] = task && label && url
        ? addPill(agentId, state.workspaceId, index, { task, label, url })
        : undefined;
    });
  }

  function addPill(
    agentId: string,
    workspaceId: string,
    index: number,
    pill: Omit<Pill, "remove">,
  ): Pill {
    const { task, label } = pill;
    const registration = client.addComposerPill({
      id: pillId(index),
      workspaceId,
      agentId,
      button: {
        title: label === task ? `Open task ${task}` : `Open ${label} (task ${task})`,
        icon: "SquareKanban",
        label,
        behavior: {
          kind: "action",
          async onPress() {
            // Read on press as well so another client's save cannot open a stale link.
            const next = await client.rpc(getTaskLinkSettings, {});
            applySettings(next);
            const current = agents.get(agentId)?.pills[index];
            if (!stopped && current) await openExternalUrl(current.url);
          },
        },
      },
    });
    return { ...pill, remove: () => registration.remove() };
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
    dropPills(state);
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
      pills: previous?.pills ?? [],
    };
    agents.set(agent.id, state);
    // Pills belong to a workspace track, so a moved agent needs new ones.
    if (previous && previous.workspaceId !== agent.workspaceId) dropPills(state);

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
  const streams = createSubscriptionKeeper();
  void seedWorkspaces(client, streams).then((entries) => {
    if (stopped) return;
    for (const workspace of entries) rememberWorkspace(workspace);
    return seedAgents(client, register, streams);
  });

  return () => {
    stopped = true;
    clearInterval(settingsTimer);
    removeSettings();
    removeCommand();
    unsubscribeAgents();
    unsubscribeWorkspaces();
    streams.release();
    for (const agentId of [...agents.keys()]) remove(agentId);
    workspaces.clear();
    branches.clear();
  };
}

async function seedWorkspaces(client: PluginClientContext, streams: SubscriptionKeeper) {
  try {
    const result = await client.paseo.workspaces.list({ subscribe: {} });
    streams.keep(result);
    return result.entries;
  } catch (error) {
    console.error("[task-link] could not list workspaces", error);
    return [];
  }
}

async function seedAgents(
  client: PluginClientContext,
  register: (agent: PaseoAgent) => void,
  streams: SubscriptionKeeper,
) {
  try {
    let cursor: string | undefined;
    do {
      const response = await client.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: {} }),
      });
      streams.keep(response);
      for (const { agent } of response.entries) register(agent);
      cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } catch (error) {
    console.error("[task-link] could not list agents", error);
  }
}
