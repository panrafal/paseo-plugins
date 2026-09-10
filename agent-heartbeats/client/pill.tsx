import type { PaseoAgent } from "@getpaseo/client";
import type {
  PluginButtonIconProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect } from "react";
import { useHeartbeats } from "./use-heartbeats";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "agent-heartbeats-agents";
export const HEARTBEATS_PANEL_ID = "heartbeats";

/**
 * Paseo renders the pill chrome and its label, so the count reaches the label
 * through the registration. The icon mounts only while the pill is on screen,
 * which keeps the heartbeat poll scoped to the visible agent.
 */
function HeartbeatIcon({
  host,
  agentId,
  size,
  color,
  onCount,
}: PluginButtonIconProps & { agentId: string; onCount: (count: number) => void }) {
  const { query } = useHeartbeats(host.id, agentId);
  const count = query.data?.heartbeats.length;
  useEffect(() => {
    if (count !== undefined) onCount(count);
  }, [count, onCount]);
  return <Icon name="HeartPulse" size={size} color={color} />;
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
    let registration: PluginButtonRegistration | null = null;
    let label = "0";
    // Stable across renders so the icon's effect only fires when the count moves.
    const report = (count: number) => {
      const next = String(count);
      if (next === label) return;
      label = next;
      registration?.update({ label: next });
    };
    registration = client.addComposerPill({
      id: "heartbeats",
      workspaceId,
      agentId,
      button: {
        title: "Manage this agent's heartbeats",
        icon: (props) => <HeartbeatIcon {...props} agentId={agentId} onCount={report} />,
        label,
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel(HEARTBEATS_PANEL_ID, { workspaceId, agentId });
          },
        },
      },
    });
    const current = registration;
    pills.set(agentId, { workspaceId, remove: () => current.remove() });
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
