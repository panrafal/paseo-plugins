import type { PluginServerContext } from "@getpaseo/plugin/server";
import { clearDecorationCache, readDecorations } from "./server/decorations";
import { flushUnreadWrites, readUnreadMarks, writeUnreadMark } from "./server/unread";
import { getDecorations, listUnreadMarks, setUnreadMark } from "./shared/contracts";

/**
 * The dashboard reads workspaces and agents through the client SDK; only the three things that
 * live on the daemon's disk — project icons, the label catalog and the plugin's own unread
 * marks — need a server side.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(getDecorations, readDecorations);
  server.handle(listUnreadMarks, readUnreadMarks);
  server.handle(setUnreadMark, writeUnreadMark);
  return async () => {
    clearDecorationCache();
    await flushUnreadWrites();
  };
}
