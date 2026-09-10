import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  forgetTurnOutput,
  inspectAgents,
  rememberTurnEnded,
} from "./server/inspect-usage";
import { scheduleAgentResume } from "./server/schedule-resume";
import { inspectUsageRpc, scheduleResumeRpc } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const stopStarted =
    typeof server.on === "function"
      ? server.on("agent.turn_started", (event) => {
          forgetTurnOutput(event.agent.id);
        })
      : () => {};
  const stopEnded =
    typeof server.on === "function"
      ? server.on("agent.turn_ended", (event) => {
          if (event.outcome.kind === "canceled") {
            forgetTurnOutput(event.agent.id);
            return;
          }
          rememberTurnEnded(event);
        })
      : () => {};
  server.handle(inspectUsageRpc, inspectAgents);
  server.handle(scheduleResumeRpc, scheduleAgentResume);
  return () => {
    stopStarted();
    stopEnded();
  };
}
