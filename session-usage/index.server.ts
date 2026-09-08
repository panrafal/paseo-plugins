import type { PluginServerContext } from "@getpaseo/plugin/server";
import { UsageIndex } from "./server/indexer";
import { listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const index = new UsageIndex();
  server.handle(listUsage, ({ refresh }) => index.snapshot(refresh));
  return () => index.dispose();
}
