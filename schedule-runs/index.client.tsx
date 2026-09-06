import type { PluginClientContext } from "@getpaseo/plugin";
import { RunsSurface } from "./client/runs-surface";

/**
 * Registers the run feed as a sidebar surface next to New workspace, History, and Schedules,
 * plus a Command Center entry that opens it. Contribution ids must match `^[a-z][a-z0-9-]*$`;
 * a surface opened straight from the Command Center is titled with the surface id, so the id
 * is kept readable.
 */
const SURFACE_ID = "schedule-runs";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addSurface(SURFACE_ID, RunsSurface),
    client.addSidebarItem({
      id: "runs",
      title: "Schedule runs",
      icon: "CalendarClock",
      surface: SURFACE_ID,
    }),
    client.addCommandCenterItem({
      id: "open-schedule-runs",
      title: "Open schedule runs",
      icon: "CalendarClock",
      keywords: ["schedule", "schedules", "runs", "cron", "heartbeat", "history", "output"],
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
