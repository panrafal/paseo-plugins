import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readBranch } from "./server/branch";
import { getBranch } from "./shared/task";
import { readTaskLinkSettings, writeTaskLinkSettings } from "./server/settings";
import { getTaskLinkSettings, setTaskLinkSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.handle(getBranch, readBranch);
  server.handle(getTaskLinkSettings, readTaskLinkSettings);
  server.handle(setTaskLinkSettings, writeTaskLinkSettings);
  return () => {};
}
