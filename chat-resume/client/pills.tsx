import { type PluginClientContext } from "@getpaseo/plugin/client";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { inspectUsageRpc, scheduleResumeRpc } from "../shared/contracts";
import {
  HANDOVER_SOURCE_LABEL,
  similarMode,
  similarThinkingOption,
} from "../shared/handover";
import { CONTINUE_PROMPT, resumeAction, type ResumeAction } from "../shared/usage";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "chat-resume-agents";
const HANDOVER_PANEL_ID = "handover-draft";
const INSPECT_BATCH = 200;
const FLUSH_DELAY_MS = 16;
const RETRY_DELAY_MS = 800;

interface RegisteredPill {
  workspaceId: string;
  signature: string;
  remove: () => void;
}

interface AgentPills {
  resume?: RegisteredPill;
  handover?: RegisteredPill;
}

interface UsageInspection {
  exhausted: boolean;
  resetAt: string | null;
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
  const inspection = await client.rpc(inspectUsageRpc, { agentIds: [sourceAgentId] });
  if (!inspection.inspections[0]?.exhausted) {
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

function canShowPills(agent: PaseoAgent): boolean {
  return Boolean(agent.workspaceId) && !agent.archivedAt && (agent.status === "idle" || agent.status === "error");
}

export function contributePills(client: PluginClientContext) {
  const agents = new Map<string, PaseoAgent>();
  const pills = new Map<string, AgentPills>();
  const inspections = new Map<string, UsageInspection>();
  const resumeScheduled = new Set<string>();
  const handoverTargets = new Map<string, string>();
  const resumePending = new Set<string>();
  const handoverPending = new Set<string>();
  const inspectQueued = new Set<string>();
  const retried = new Set<string>();
  const pendingRetry = new Set<string>();
  const flipTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let inspecting = false;
  let stopped = false;

  function removePill(agentId: string, kind: keyof AgentPills) {
    const registered = pills.get(agentId);
    registered?.[kind]?.remove();
    if (registered) delete registered[kind];
    if (registered && !registered.resume && !registered.handover) pills.delete(agentId);
  }

  function removeAll(agentId: string) {
    const flip = flipTimers.get(agentId);
    if (flip) {
      clearTimeout(flip);
      flipTimers.delete(agentId);
    }
    removePill(agentId, "resume");
    removePill(agentId, "handover");
  }

  function armFlip(agentId: string, resetAt: Date | null) {
    const existing = flipTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      flipTimers.delete(agentId);
    }
    if (!resetAt) return;
    const delay = resetAt.getTime() - Date.now();
    if (delay <= 0) return;
    flipTimers.set(
      agentId,
      setTimeout(() => {
        flipTimers.delete(agentId);
        const agent = agents.get(agentId);
        if (agent) sync(agent);
      }, Math.min(delay + 100, 2_147_000_000)),
    );
  }

  function registerResume(agent: PaseoAgent, action: ResumeAction, resetAt: Date | null) {
    if (!agent.workspaceId || resumeScheduled.has(agent.id)) {
      removePill(agent.id, "resume");
      return;
    }
    const signature = `${agent.workspaceId}:${action}:${resetAt?.toISOString() ?? "none"}`;
    const existing = pills.get(agent.id)?.resume;
    if (existing?.signature === signature) return;
    removePill(agent.id, "resume");

    const due = action === "continue";
    const registration = client.addComposerPill({
      id: "resume-after-renewal",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: due
          ? "Continue now that the provider allowance should have renewed"
          : `Schedule one resume heartbeat for ${resetAt?.toLocaleString() ?? "renewal"}`,
        icon: due ? "Play" : "RotateCcw",
        label: due ? "Continue" : "Resume when renewed",
        behavior: {
          kind: "action",
          async onPress() {
            if (resumePending.has(agent.id)) return;
            resumePending.add(agent.id);
            try {
              if (due) {
                await client.paseo.agents.ref(agent.id).send(CONTINUE_PROMPT);
                removeAll(agent.id);
              } else {
                await client.rpc(scheduleResumeRpc, { agentId: agent.id });
                resumeScheduled.add(agent.id);
                removePill(agent.id, "resume");
              }
            } catch (error) {
              console.error("[chat-resume] could not resume", agent.id, error);
              throw error;
            } finally {
              resumePending.delete(agent.id);
            }
          },
        },
      },
    });
    const state = pills.get(agent.id) ?? {};
    state.resume = {
      workspaceId: agent.workspaceId,
      signature,
      remove: () => registration.remove(),
    };
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

    const registration = client.addComposerPill({
      id: "handover-provider",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Prepare a handover on the next ready provider",
        icon: "ArrowRightLeft",
        label: "Handover",
        behavior: {
          kind: "action",
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
        },
      },
    });
    const state = pills.get(agent.id) ?? {};
    state.handover = {
      workspaceId: agent.workspaceId,
      signature,
      remove: () => registration.remove(),
    };
    pills.set(agent.id, state);
  }

  function sync(agent: PaseoAgent) {
    if (stopped) return;
    if (!canShowPills(agent)) {
      resumeScheduled.delete(agent.id);
      removeAll(agent.id);
      return;
    }

    const inspection = inspections.get(agent.id);
    if (!inspection) return;
    if (!inspection.exhausted) {
      resumeScheduled.delete(agent.id);
      removeAll(agent.id);
      return;
    }

    const resetAt = inspection.resetAt ? new Date(inspection.resetAt) : null;
    const parsedReset = resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null;
    registerResume(agent, resumeAction(parsedReset), parsedReset);
    registerHandover(agent);
    armFlip(agent.id, parsedReset);
  }

  function queueInspect(agent: PaseoAgent, retry = false) {
    if (stopped || !canShowPills(agent)) {
      inspections.delete(agent.id);
      removeAll(agent.id);
      return;
    }
    if (retry) retried.add(agent.id);
    inspectQueued.add(agent.id);
    if (flushTimer || inspecting) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flushInspect();
    }, FLUSH_DELAY_MS);
  }

  async function flushInspect() {
    if (inspecting || stopped) return;
    const ids = [...inspectQueued];
    if (ids.length === 0) return;
    inspectQueued.clear();
    inspecting = true;
    try {
      for (let offset = 0; offset < ids.length; offset += INSPECT_BATCH) {
        if (stopped) return;
        const batch = ids.slice(offset, offset + INSPECT_BATCH);
        const { inspections: rows } = await client.rpc(inspectUsageRpc, { agentIds: batch });
        for (const row of rows) {
          inspections.set(row.agentId, { exhausted: row.exhausted, resetAt: row.resetAt });
          const agent = agents.get(row.agentId);
          if (!agent) continue;
          if (inspectQueued.has(agent.id)) continue;
          sync(agent);
          const shouldRetry = pendingRetry.has(row.agentId);
          pendingRetry.delete(row.agentId);
          if (!row.exhausted && shouldRetry && agent.status === "idle" && !retried.has(agent.id)) {
            const snapshot = agent;
            setTimeout(() => {
              const current = agents.get(snapshot.id);
              if (!current || current.updatedAt !== snapshot.updatedAt || stopped) return;
              queueInspect(current, true);
            }, RETRY_DELAY_MS);
          }
        }
      }
    } catch (error) {
      console.error("[chat-resume] could not inspect usage", error);
    } finally {
      inspecting = false;
      if (inspectQueued.size > 0 && !stopped) void flushInspect();
    }
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
      inspections.delete(agent.id);
      retried.delete(agent.id);
      pendingRetry.delete(agent.id);
      removeAll(agent.id);
      return;
    }
    agents.set(agent.id, agent);

    if (!canShowPills(agent)) {
      inspections.delete(agent.id);
      retried.delete(agent.id);
      pendingRetry.delete(agent.id);
      removeAll(agent.id);
      return;
    }

    const unchanged =
      previous &&
      previous.updatedAt === agent.updatedAt &&
      previous.status === agent.status &&
      previous.lastError === agent.lastError;
    if (unchanged && inspections.has(agent.id)) {
      sync(agent);
      return;
    }
    if (previous && previous.updatedAt !== agent.updatedAt) retried.delete(agent.id);
    const justFinished = previous?.status === "running" && agent.status === "idle";
    if (justFinished) pendingRetry.add(agent.id);
    queueInspect(agent);
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
      inspections.delete(update.agentId);
      retried.delete(update.agentId);
      pendingRetry.delete(update.agentId);
      inspectQueued.delete(update.agentId);
      removeAll(update.agentId);
    } else upsert(update.agent);
  });

  void seedAgents(client.paseo, upsert);

  return () => {
    stopped = true;
    unsubscribe();
    if (flushTimer) clearTimeout(flushTimer);
    for (const timer of flipTimers.values()) clearTimeout(timer);
    flipTimers.clear();
    for (const agentId of [...pills.keys()]) removeAll(agentId);
    agents.clear();
    inspections.clear();
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
