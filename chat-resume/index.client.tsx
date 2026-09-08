import type { PluginClientContext } from "@getpaseo/plugin/client";
import { HandoverDraftPanel } from "./client/handover-panel";
import { contributePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  const removePanel = client.addWorkspacePanel({
    id: "handover-draft",
    title: "Handover draft",
    icon: "ArrowRightLeft",
    context: "agent",
    Component: HandoverDraftPanel,
  });
  const removePills = contributePills(client);
  return () => {
    removePills();
    removePanel();
  };
}
