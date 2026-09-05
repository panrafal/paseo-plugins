import type { PluginServerContext } from "@getpaseo/plugin";
import { scheduleAgentResume } from "./server/schedule-resume";
import { scheduleResumeRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(scheduleResumeRpc, scheduleAgentResume);
  return () => {};
}
