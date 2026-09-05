import type { PluginClientContext } from "@getpaseo/plugin";
import { HeartbeatsPanel } from "./client/panel";
import { contributePills, HEARTBEATS_PANEL_ID } from "./client/pill";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: HEARTBEATS_PANEL_ID,
    title: "Heartbeats",
    icon: "HeartPulse",
    context: "agent",
    Component: HeartbeatsPanel,
  });
  const removePills = contributePills(client);
  return () => {
    removePills();
    void removePanel();
  };
}
