import type { PluginServerContext } from "@getpaseo/plugin/server";
import { scheduleAgentResume } from "./server/schedule-resume";
import { scheduleResumeRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(scheduleResumeRpc, scheduleAgentResume);
  return () => {};
}
