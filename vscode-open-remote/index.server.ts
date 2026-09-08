import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readEditorSettings, writeEditorSettings } from "./server/settings";
import { getEditorSettings, setEditorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.handle(getEditorSettings, readEditorSettings);
  server.handle(setEditorSettings, writeEditorSettings);
  return () => {};
}
