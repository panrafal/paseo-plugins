import {
  Icon,
  type PluginClientContext,
  type PluginComposerPillProps,
} from "@getpaseo/plugin";
import type { PaseoAgent } from "@getpaseo/client";
import React, { useEffect } from "react";
import { Dimensions, Linking, Platform, Text } from "react-native";
import { getEditorSettings } from "../shared/settings";
import { isMobileBrowser, isMobileLayout, remoteEditorUrl } from "../shared/url";

const AGENT_PAGE_SIZE = 200;
const AGENT_SUBSCRIPTION_ID = "vscode-open-remote-agents";
const PROTOCOL_WINDOW_CLOSE_DELAY_MS = 750;
const TABLET_MIN_SHORTEST_SIDE = 600;

interface DesktopOpenerBridge {
  readonly opener?: { readonly openUrl?: (url: string) => Promise<void> };
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isMobileRuntime(): boolean {
  if (Platform.OS === "ios" || Platform.OS === "android") return true;
  return Platform.OS === "web" && isMobileBrowser();
}

function shouldDisplayEditorPill(screen: { width: number; height: number }): boolean {
  if (!isMobileRuntime()) return true;
  return Math.min(screen.width, screen.height) >= TABLET_MIN_SHORTEST_SIDE;
}

async function openExternalUrl(url: string, mobile: boolean): Promise<void> {
  const openUrl = (globalThis as { paseoDesktop?: DesktopOpenerBridge }).paseoDesktop?.opener
    ?.openUrl;
  if (!mobile && isHttpUrl(url) && typeof openUrl === "function") {
    await openUrl(url);
    return;
  }

  // Paseo's desktop opener intentionally accepts HTTP(S) only. React Native
  // Web can still hand a custom scheme to the operating system, but does so
  // through a child window. Keep a reference and close that transient window
  // once the registered desktop application has received it.
  if (!mobile && !isHttpUrl(url) && typeof window !== "undefined") {
    const protocolWindow = window.open(url, "paseo-remote-editor");
    if (!protocolWindow) {
      throw new Error("The desktop client blocked the remote editor launch.");
    }
    window.setTimeout(() => protocolWindow.close(), PROTOCOL_WINDOW_CLOSE_DELAY_MS);
    return;
  }

  await Linking.openURL(url);
}

type RenderedTarget = {
  hostName: string | null;
  mobile: boolean;
};

function RemoteEditorPill({
  theme,
  host,
  layout,
  target,
}: PluginComposerPillProps & { target: RenderedTarget }) {
  // The headless client entrypoint does not receive host or layout metadata.
  // The rendered pill does, so keep the latest values for its press callback.
  useEffect(() => {
    target.hostName = host.label;
    target.mobile = isMobileLayout(layout);
    return () => {
      if (target.hostName === host.label) target.hostName = null;
    };
  }, [host.label, layout, target]);

  return (
    <>
      <Icon name="SquareCode" size={14} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flexShrink: 1 }}>
        Editor
      </Text>
    </>
  );
}

type AgentPill = {
  workspaceId: string;
  cwd: string;
  updatedAt: string;
  remove: () => void;
};

/**
 * One pill per non-archived agent on the daemon where this plugin is installed.
 * Install the plugin on remote Paseo hosts; each installation is scoped to its
 * own host, so it cannot add pills to agents on any other daemon.
 */
export function contributeClient(client: PluginClientContext) {
  const agents = new Map<string, PaseoAgent>();
  const pills = new Map<string, AgentPill>();
  let pillsVisible = shouldDisplayEditorPill(Dimensions.get("screen"));
  let stopped = false;

  function remove(agentId: string) {
    const current = pills.get(agentId);
    if (!current) return;
    current.remove();
    pills.delete(agentId);
  }

  function registerPill(agent: PaseoAgent) {
    if (stopped || !pillsVisible || !agent.workspaceId) return;
    const previous = pills.get(agent.id);
    if (
      previous &&
      previous.workspaceId === agent.workspaceId &&
      previous.cwd === agent.cwd
    ) {
      previous.updatedAt = agent.updatedAt;
      return;
    }
    remove(agent.id);

    const target: RenderedTarget = { hostName: null, mobile: false };
    const Component = (props: PluginComposerPillProps) => (
      <RemoteEditorPill {...props} target={target} />
    );
    const { id: agentId, workspaceId, cwd } = agent;
    const removePill = client.addComposerPill({
      id: "open-remote-editor",
      title: "Open this agent directory in the remote editor",
      workspaceId,
      agentId,
      Component,
      async onPress() {
        if (!target.hostName) throw new Error("The Paseo host name is not available yet.");
        const settings = await client.rpc(getEditorSettings, {});
        await openExternalUrl(
          remoteEditorUrl({
            settings,
            hostName: target.hostName,
            directory: cwd,
            mobile: target.mobile,
          }),
          target.mobile,
        );
      },
    });
    pills.set(agent.id, {
      workspaceId,
      cwd,
      updatedAt: agent.updatedAt,
      remove: removePill,
    });
  }

  function upsert(agent: PaseoAgent) {
    const previous = agents.get(agent.id);
    if (previous && previous.updatedAt > agent.updatedAt) return;
    if (!agent.workspaceId || agent.archivedAt) {
      agents.delete(agent.id);
      remove(agent.id);
      return;
    }
    agents.set(agent.id, agent);
    if (pillsVisible) registerPill(agent);
    else remove(agent.id);
  }

  const dimensionsSubscription = Dimensions.addEventListener("change", ({ screen }) => {
    const nextVisible = shouldDisplayEditorPill(screen);
    if (nextVisible === pillsVisible) return;
    pillsVisible = nextVisible;
    if (pillsVisible) {
      for (const agent of agents.values()) registerPill(agent);
    } else {
      for (const agentId of [...pills.keys()]) remove(agentId);
    }
  });

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      agents.delete(update.agentId);
      remove(update.agentId);
    } else {
      upsert(update.agent);
    }
  });

  void seedAgents(client, upsert);

  return () => {
    stopped = true;
    unsubscribe();
    dimensionsSubscription.remove();
    agents.clear();
    for (const agentId of [...pills.keys()]) remove(agentId);
  };
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
    console.error("[vscode-open-remote] could not list agents", error);
  }
}
