import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeClient } from "./client/pill";
import { SettingsSurface } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  const removeSettings = client.addSettingsScreen({
    id: "settings",
    title: "Remote editor",
    icon: "SquareCode",
    Component: SettingsSurface,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "configure-remote-editor",
    title: "Configure remote editor",
    icon: "SquareCode",
    keywords: ["vscode", "vs code", "cursor", "ssh", "remote", "prefix"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("settings");
    },
  });

  const removePills = contributeClient(client);
  return () => {
    removePills();
    removeCommand();
    removeSettings();
  };
}
