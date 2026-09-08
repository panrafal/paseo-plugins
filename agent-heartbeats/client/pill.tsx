import type { PaseoAgent } from "@getpaseo/client";
import type { PluginClientContext, PluginComposerPillProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text } from "react-native";
import { useHeartbeats } from "./use-heartbeats";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "agent-heartbeats-agents";
export const HEARTBEATS_PANEL_ID = "heartbeats";

function HeartbeatPill({ theme, host, agentId }: PluginComposerPillProps) {
  const { query } = useHeartbeats(host.id, agentId);
  const count = query.data?.heartbeats.length ?? 0;
  return (
    <>
      <Icon name="HeartPulse" size={14} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] }}>
        {count}
      </Text>
    </>
  );
}

interface RegisteredPill {
  workspaceId: string;
  remove: () => void;
}

export function contributePills(client: PluginClientContext) {
  const pills = new Map<string, RegisteredPill>();
  let stopped = false;

  function remove(agentId: string) {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  }

  function upsert(agent: PaseoAgent) {
    if (stopped || !agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const { id: agentId, workspaceId } = agent;
    pills.set(agentId, {
      workspaceId,
      remove: client.addComposerPill({
        id: "heartbeats",
        title: "Manage this agent's heartbeats",
        workspaceId,
        agentId,
        Component: HeartbeatPill,
        onPress() {
          client.openPanel(HEARTBEATS_PANEL_ID, { workspaceId, agentId });
        },
      }),
    });
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") remove(update.agentId);
    else upsert(update.agent);
  });

  void seedAgents(client, upsert);

  return () => {
    stopped = true;
    unsubscribe();
    for (const agentId of [...pills.keys()]) remove(agentId);
  };
}

async function seedAgents(client: PluginClientContext, upsert: (agent: PaseoAgent) => void) {
  try {
    let cursor: string | undefined;
    do {
      const response = await client.paseo.agents.list({
        filter: { includeArchived: false },
        page: { limit: AGENT_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
        ...(cursor ? {} : { subscribe: { subscriptionId: AGENT_SUBSCRIPTION_ID } }),
      });
      for (const { agent } of response.entries) upsert(agent);
      cursor = response.pageInfo.hasMore ? (response.pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
  } catch (error) {
    console.error("[agent-heartbeats] could not list agents", error);
  }
}
