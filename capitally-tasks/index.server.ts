import type { PluginServerContext } from "@getpaseo/plugin";
import { readBranch } from "./server/branch";
import { getBranch } from "./shared/task";

export default function contribute(server: PluginServerContext) {
  server.handle(getBranch, readBranch);
  return () => {};
}
