import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Mirrors the daemon's own `resolvePaseoHome`, so the plugin reads and writes the directory the
 * daemon actually uses. A `PASEO_HOME` set from a unit file, a container image or a launchd plist
 * commonly carries a literal `~`, which the shell never expanded; without the same expansion the
 * plugin would look for the label catalog and the project icons somewhere else entirely and would
 * store its unread marks under the plugin process' working directory.
 */
export function paseoHome(): string {
  const raw = process.env.PASEO_HOME ?? "~/.paseo";
  if (raw === "~") return homedir();
  return resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}
