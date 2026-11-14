import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { HistoryScreen } from "./client/history-screen";

/** Contribution ids must match `^[a-z][a-z0-9-]*$`. */
const SCREEN_ID = "agents-history";
const TITLE = "Agents history";

function HistorySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="History"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: SCREEN_ID, title: TITLE, Component: HistoryScreen }),
    client.addSidebarHeaderItem({ id: "history", title: TITLE, Component: HistorySidebarItem }),
    client.addCommandCenterItem({
      id: "open-agents-history",
      title: "Open agents history",
      icon: "History",
      keywords: ["history", "archived", "workspaces", "agents", "search", "grep", "transcript"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const remove of removers) void remove();
  };
}
