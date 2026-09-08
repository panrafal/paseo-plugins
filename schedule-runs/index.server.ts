import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clearRunCaches, listRuns } from "./server/schedules";
import { listScheduleRuns } from "./shared/contracts";

/**
 * The feed needs the daemon's disk (schedule records with their run outputs, and the workspace
 * registry that still lists archived workspaces), so listing lives here; the client only
 * filters and renders.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(listScheduleRuns, (input, context) => listRuns(input, context.paseo));
  return () => {
    clearRunCaches();
  };
}
