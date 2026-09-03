import type { PluginClientContext } from "@getpaseo/plugin";
import { contributeClient } from "./client/pill";
import { SettingsSurface } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSurface("settings", SettingsSurface);
  client.addCommandCenterItem({
    id: "configure-remote-editor",
    title: "Configure remote editor",
    icon: "SquareCode",
    keywords: ["vscode", "vs code", "cursor", "ssh", "remote", "prefix"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("settings");
    },
  });

  return contributeClient(client);
}
