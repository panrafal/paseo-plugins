import type { PluginClientContext } from "@getpaseo/plugin";
import { DashSurface } from "./client/dash-surface";

/**
 * Registers the dash as a sidebar surface next to New workspace, History, and Schedules, plus a
 * Command Center entry that opens it.
 *
 * Contribution ids must match `^[a-z][a-z0-9-]*$`. The sidebar route titles the screen with the
 * sidebar item's title; a surface opened straight from the Command Center is titled with the
 * surface id, so the id is kept readable.
 */
const SURFACE_ID = "agents-dash";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSurface(SURFACE_ID, DashSurface),
    client.addSidebarItem({
      id: "dash",
      title: "Agents dash",
      icon: "LayoutList",
      surface: SURFACE_ID,
    }),
    client.addCommandCenterItem({
      id: "open-dash",
      title: "Open agents dash",
      icon: "LayoutList",
      keywords: ["agents", "workspaces", "dashboard", "status", "unread", "waiting"],
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
