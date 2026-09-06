import type { PluginClientContext } from "@getpaseo/plugin";
import { HistorySurface } from "./client/history-surface";

/**
 * Contribution ids must match `^[a-z][a-z0-9-]*$`. A surface opened from the Command Center is
 * titled with the surface id, so it stays readable.
 */
const SURFACE_ID = "agents-history";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSurface(SURFACE_ID, HistorySurface),
    client.addSidebarItem({
      id: "history",
      title: "Agents history",
      icon: "History",
      surface: SURFACE_ID,
    }),
    client.addCommandCenterItem({
      id: "open-agents-history",
      title: "Open agents history",
      icon: "History",
      keywords: ["history", "archived", "workspaces", "agents", "search", "grep", "transcript"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface(SURFACE_ID);
      },
    }),
  ];
  return () => {
    for (const remove of removers) void remove();
  };
}
