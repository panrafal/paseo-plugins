import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { usageFromSources, type UsageMatch } from "../shared/usage";
import { lastAssistantMessage } from "./transcript-tail";

const INSPECT_CONCURRENCY = 8;

export interface UsageInspection {
  agentId: string;
  exhausted: boolean;
  resetAt: string | null;
}

const turnOutput = new Map<string, { text: string; observedAt: string }>();

export function rememberTurnOutput(agentId: string, text: string, observedAt = new Date().toISOString()): void {
  const trimmed = text.trim();
  if (trimmed) turnOutput.set(agentId, { text: trimmed, observedAt });
  else turnOutput.delete(agentId);
}

export function forgetTurnOutput(agentId: string): void {
  turnOutput.delete(agentId);
}

export function latestTurnText(timeline: readonly AgentTimelineItem[]): string {
  let output = "";
  for (const item of timeline) {
    if (item.type === "user_message") output = "";
    else if (item.type === "assistant_message") output += item.text;
    else if (item.type === "error") output += item.message;
  }
  return output;
}

export function rememberTurnEnded(event: {
  agent: { id: string };
  outcome: { kind: string; error?: { message: string } };
  timeline: readonly AgentTimelineItem[];
}): void {
  const chunks: string[] = [];
  if (event.outcome.kind === "failed" && event.outcome.error?.message) {
    chunks.push(event.outcome.error.message);
  }
  const output = latestTurnText(event.timeline).trim();
  if (output) chunks.push(output);
  rememberTurnOutput(event.agent.id, chunks.join("\n"));
}

function toInspection(agentId: string, match: UsageMatch): UsageInspection {
  return {
    agentId,
    exhausted: match.exhausted,
    resetAt: match.resetAt ? match.resetAt.toISOString() : null,
  };
}

export async function inspectAgent(agent: PaseoAgent): Promise<UsageInspection> {
  const errorText = agent.lastError ?? null;
  const transcript = await lastAssistantMessage(agent);
  const cached = turnOutput.get(agent.id);

  if (transcript) {
    const sources = [{ text: transcript.text, observedAt: transcript.observedAt }];
    if (agent.status === "error" && errorText) {
      sources.push({ text: errorText, observedAt: agent.updatedAt });
    }
    return toInspection(agent.id, usageFromSources(sources));
  }

  const sources = [];
  if (errorText) sources.push({ text: errorText, observedAt: agent.updatedAt });
  if (cached) sources.push(cached);
  return toInspection(agent.id, usageFromSources(sources));
}

async function mapPool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
}

export async function inspectAgents(
  input: { agentIds: string[] },
  context: { paseo: PaseoApi },
): Promise<{ inspections: UsageInspection[] }> {
  const inspections = await mapPool(input.agentIds, INSPECT_CONCURRENCY, async (agentId) => {
    try {
      const refreshed = await context.paseo.agents.ref(agentId).refresh();
      const agent = refreshed?.agent;
      if (!agent) return { agentId, exhausted: false, resetAt: null };
      return inspectAgent(agent);
    } catch (error) {
      console.error("[chat-resume] could not inspect agent", agentId, error);
      return { agentId, exhausted: false, resetAt: null };
    }
  });
  return { inspections };
}
