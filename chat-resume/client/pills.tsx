import {
  type PluginClientContext,
  type PluginComposerPillProps,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import React from "react";
import { Text } from "react-native";
import { scheduleResumeRpc } from "../shared/contracts";
import {
  HANDOVER_SOURCE_LABEL,
  similarMode,
  similarThinkingOption,
} from "../shared/handover";
import { isUsageExhaustedError, usageResetAt } from "../shared/usage";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "chat-resume-agents";
const HANDOVER_PANEL_ID = "handover-draft";

function Pill({ icon, label, theme }: PluginComposerPillProps & { icon: string; label: string }) {
  return (
    <>
      <Icon name={icon} size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>
        {label}
      </Text>
    </>
  );
}

interface RegisteredPill {
  workspaceId: string;
  signature: string;
  remove: () => void;
}

interface AgentPills {
  resume?: RegisteredPill;
  handover?: RegisteredPill;
}

function nextReadyProvider<T extends { provider: string; status: string; enabled: boolean }>(
  entries: readonly T[],
  currentProvider: string,
): T | null {
  if (entries.length === 0) return null;
  const currentIndex = entries.findIndex((entry) => entry.provider === currentProvider);
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = currentIndex < 0 ? offset - 1 : (currentIndex + offset) % entries.length;
    const entry = entries[index];
    if (entry.enabled && entry.status === "ready" && entry.provider !== currentProvider) return entry;
  }
  return null;
}

async function createHandoverAgent(client: PluginClientContext, sourceAgentId: string) {
  const refreshed = await client.paseo.agents.ref(sourceAgentId).refresh();
  const source = refreshed?.agent;
  if (!source || !source.workspaceId) throw new Error(`Agent not found: ${sourceAgentId}`);
  if (source.status !== "error" || !isUsageExhaustedError(source.lastError)) {
    throw new Error("The agent's latest failure is no longer a usage-limit failure.");
  }

  const snapshot = await client.paseo.providers.waitForReady({ cwd: source.cwd, timeoutMs: 15_000 });
  const provider = nextReadyProvider(snapshot.entries, source.provider);
  if (!provider) throw new Error("No other ready provider is available.");

  const modelsResult = provider.models?.length
    ? { models: provider.models, error: null }
    : await client.paseo.providers.listModels(provider.provider, { cwd: source.cwd });
  if (modelsResult.error) throw new Error(modelsResult.error);
  const selectableModels = (modelsResult.models ?? []).filter((model) => model.isSelectable !== false);
  const model = selectableModels.find((candidate) => candidate.isDefault) ?? selectableModels[0];
  if (!model) throw new Error(`Provider ${provider.provider} has no selectable model.`);

  const modesResult = provider.modes?.length
    ? { modes: provider.modes, error: null }
    : await client.paseo.providers.listModes(provider.provider, { cwd: source.cwd });
  if (modesResult.error) throw new Error(modesResult.error);
  const modeId = similarMode(source.currentModeId, modesResult.modes ?? [], provider.defaultModeId);
  const thinkingOptionId = similarThinkingOption(
    source.effectiveThinkingOptionId ?? source.thinkingOptionId,
    model.thinkingOptions ?? [],
  ) ?? model.defaultThinkingOptionId;

  const target = await client.paseo.agents.create({
    config: {
      provider: `${provider.provider}/${model.id}`,
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    },
    cwd: source.cwd,
    title: `Handover: ${source.title ?? source.id.slice(0, 7)}`,
    labels: { [HANDOVER_SOURCE_LABEL]: source.id },
  });
  client.openPanel(HANDOVER_PANEL_ID, {
    workspaceId: source.workspaceId,
    agentId: target.id,
    location: "workspace",
  });
  return target.id;
}

export function contributePills(client: PluginClientContext) {
  const agents = new Map<string, PaseoAgent>();
  const pills = new Map<string, AgentPills>();
  const resumeScheduled = new Set<string>();
  const handoverTargets = new Map<string, string>();
  const resumePending = new Set<string>();
  const handoverPending = new Set<string>();
  let stopped = false;

  function removePill(agentId: string, kind: keyof AgentPills) {
    const registered = pills.get(agentId);
    registered?.[kind]?.remove();
    if (registered) delete registered[kind];
    if (registered && !registered.resume && !registered.handover) pills.delete(agentId);
  }

  function removeAll(agentId: string) {
    removePill(agentId, "resume");
    removePill(agentId, "handover");
  }

  function registerResume(agent: PaseoAgent, resetAt: Date) {
    if (!agent.workspaceId || resumeScheduled.has(agent.id)) {
      removePill(agent.id, "resume");
      return;
    }
    const signature = `${agent.workspaceId}:${resetAt.toISOString()}`;
    const existing = pills.get(agent.id)?.resume;
    if (existing?.signature === signature) return;
    removePill(agent.id, "resume");

    const Component = (props: PluginComposerPillProps) => (
      <Pill {...props} icon="RotateCcw" label="Resume when renewed" />
    );
    const remove = client.addComposerPill({
      id: "resume-after-renewal",
      title: `Schedule one resume heartbeat for ${resetAt.toLocaleString()}`,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      Component,
      async onPress() {
        if (resumePending.has(agent.id)) return;
        resumePending.add(agent.id);
        try {
          await client.rpc(scheduleResumeRpc, { agentId: agent.id });
          resumeScheduled.add(agent.id);
          removePill(agent.id, "resume");
        } catch (error) {
          console.error("[chat-resume] could not schedule resume", agent.id, error);
          throw error;
        } finally {
          resumePending.delete(agent.id);
        }
      },
    });
    const state = pills.get(agent.id) ?? {};
    state.resume = { workspaceId: agent.workspaceId, signature, remove };
    pills.set(agent.id, state);
  }

  function registerHandover(agent: PaseoAgent) {
    if (!agent.workspaceId || handoverTargets.has(agent.id)) {
      removePill(agent.id, "handover");
      return;
    }
    const signature = agent.workspaceId;
    const existing = pills.get(agent.id)?.handover;
    if (existing?.signature === signature) return;
    removePill(agent.id, "handover");

    const Component = (props: PluginComposerPillProps) => (
      <Pill {...props} icon="ArrowRightLeft" label="Handover" />
    );
    const remove = client.addComposerPill({
      id: "handover-provider",
      title: "Prepare a handover on the next ready provider",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      Component,
      async onPress() {
        if (handoverPending.has(agent.id)) return;
        handoverPending.add(agent.id);
        try {
          const targetId = await createHandoverAgent(client, agent.id);
          handoverTargets.set(agent.id, targetId);
          removePill(agent.id, "handover");
        } catch (error) {
          console.error("[chat-resume] could not prepare handover", agent.id, error);
          throw error;
        } finally {
          handoverPending.delete(agent.id);
        }
      },
    });
    const state = pills.get(agent.id) ?? {};
    state.handover = { workspaceId: agent.workspaceId, signature, remove };
    pills.set(agent.id, state);
  }

  function sync(agent: PaseoAgent) {
    if (stopped) return;
    const exhausted =
      Boolean(agent.workspaceId) && !agent.archivedAt && agent.status === "error" &&
      isUsageExhaustedError(agent.lastError);
    if (!exhausted) {
      resumeScheduled.delete(agent.id);
      removeAll(agent.id);
      return;
    }

    const resetAt = usageResetAt(agent.lastError, agent.updatedAt);
    if (resetAt) registerResume(agent, resetAt);
    else removePill(agent.id, "resume");
    registerHandover(agent);
  }

  function upsert(agent: PaseoAgent) {
    const previous = agents.get(agent.id);
    if (previous && previous.updatedAt > agent.updatedAt) return;

    const sourceId = agent.labels[HANDOVER_SOURCE_LABEL];
    if (sourceId && !agent.archivedAt) {
      handoverTargets.set(sourceId, agent.id);
      const source = agents.get(sourceId);
      if (source) sync(source);
    } else if (sourceId && handoverTargets.get(sourceId) === agent.id) {
      handoverTargets.delete(sourceId);
      const source = agents.get(sourceId);
      if (source) sync(source);
    }

    if (!agent.workspaceId || agent.archivedAt) {
      agents.delete(agent.id);
      removeAll(agent.id);
      return;
    }
    agents.set(agent.id, agent);
    sync(agent);
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      const removed = agents.get(update.agentId);
      const sourceId = removed?.labels[HANDOVER_SOURCE_LABEL];
      if (sourceId && handoverTargets.get(sourceId) === update.agentId) {
        handoverTargets.delete(sourceId);
        const source = agents.get(sourceId);
        if (source) sync(source);
      }
      agents.delete(update.agentId);
      removeAll(update.agentId);
    } else upsert(update.agent);
  });

  void seedAgents(client.paseo, upsert);

  return () => {
    stopped = true;
    unsubscribe();
    for (const agentId of [...pills.keys()]) removeAll(agentId);
    agents.clear();
  };
}

async function seedAgents(paseo: PaseoApi, upsert: (agent: PaseoAgent) => void) {
  try {
    let cursor: string | undefined;
    do {
      const response = await paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
      });
      for (const { agent } of response.entries) upsert(agent);
      cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } catch (error) {
    console.error("[chat-resume] could not list agents", error);
  }
}
