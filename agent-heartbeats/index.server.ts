import type { PluginServerContext } from "@getpaseo/plugin/server";
import { addHeartbeat, editHeartbeat, readHeartbeats, removeHeartbeat } from "./server/heartbeats";
import {
  createHeartbeat,
  deleteHeartbeat,
  listHeartbeats,
  updateHeartbeat,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  server.handle(listHeartbeats, readHeartbeats);
  server.handle(createHeartbeat, addHeartbeat);
  server.handle(updateHeartbeat, editHeartbeat);
  server.handle(deleteHeartbeat, removeHeartbeat);
  return () => {};
}
