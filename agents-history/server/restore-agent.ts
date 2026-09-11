import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { paseoHome } from "./paseo-home";

const runFile = promisify(execFile);
const pending = new Map<string, Promise<void>>();

export function restoreArchivedAgent(agentId: string, paseo: PaseoApi): Promise<void> {
  const existing = pending.get(agentId);
  if (existing) return existing;
  const operation = restore(agentId, paseo).finally(() => pending.delete(agentId));
  pending.set(agentId, operation);
  return operation;
}

async function restore(agentId: string, paseo: PaseoApi): Promise<void> {
  const current = await paseo.agents.ref(agentId).refresh();
  if (!current?.agent) throw new Error("Agent no longer exists.");
  // A stale history row must not reload an agent that is already active.
  if (!current.agent.archivedAt) return;

  const daemon = z.object({
    listen: z.string().min(1).optional(),
    sockPath: z.string().min(1).optional(),
  }).parse(JSON.parse(await readFile(join(paseoHome(), "paseo.pid"), "utf8")));
  const host = daemon.listen ?? daemon.sockPath;
  if (!host) throw new Error("Could not locate this daemon's address.");

  // The SDK refresh reads metadata; the CLI reload restores the provider session.
  await runFile(process.env.PASEO_CLI_PATH?.trim() || "paseo", [
    "agent", "reload", agentId, "--host", host, "--json",
  ], {
    env: { ...process.env, PASEO_HOME: paseoHome(), PASEO_HOST: "" },
    timeout: 120_000,
    maxBuffer: 64 * 1024,
  });
}
