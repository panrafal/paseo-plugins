import { spawn } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { isUsageExhaustedError, usageResetAt } from "../shared/usage";

const GRACE_MS = 2 * 60_000;
const MIN_DELAY_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 12_000;
const RESUME_PROMPT =
  "The provider token allowance should now be renewed. Continue the unfinished work from the previous turn. Review the latest conversation and workspace state before acting.";

interface ScheduleResult {
  scheduleId: string;
  scheduledFor: string;
}

interface ScheduleRow {
  id: string;
  nextRunAt?: string | null;
}

const pendingByAgent = new Map<string, Promise<ScheduleResult>>();

function cronAt(date: Date): string {
  return `${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
}

function ceilToMinute(date: Date): Date {
  return new Date(Math.ceil(date.getTime() / 60_000) * 60_000);
}

function parseJson<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`Paseo CLI returned invalid JSON: ${output.slice(0, 500)}`);
  }
}

function commandError(stderr: string, stdout: string, code: number | null): Error {
  const rendered = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
  try {
    const parsed = JSON.parse(rendered) as { error?: { message?: string }; message?: string };
    return new Error(parsed.error?.message ?? parsed.message ?? rendered);
  } catch {
    return new Error(rendered);
  }
}

function runPaseoJson<T>(args: readonly string[], agentId: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const executable = process.env.PASEO_CLI_PATH?.trim() || "paseo";
    const child = spawn(executable, [...args], {
      env: { ...process.env, PASEO_AGENT_ID: agentId },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result as T);
    };

    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Paseo CLI output exceeded 64 KiB."));
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(commandError(stderr, stdout, code));
      else {
        try {
          finish(undefined, parseJson<T>(stdout));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Paseo CLI timed out while creating the heartbeat."));
    }, COMMAND_TIMEOUT_MS);
  });
}

async function createSchedule(agentId: string, paseo: PaseoApi): Promise<ScheduleResult> {
  const refreshed = await paseo.agents.ref(agentId).refresh();
  const agent = refreshed?.agent;
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (agent.status !== "error" || !isUsageExhaustedError(agent.lastError)) {
    throw new Error("The agent's latest failure is no longer a usage-limit failure.");
  }

  const resetAt = usageResetAt(agent.lastError, agent.updatedAt);
  if (!resetAt) {
    throw new Error("The latest usage-limit failure does not include a renewal time.");
  }
  const now = Date.now();
  const scheduledAt = ceilToMinute(
    new Date(Math.max(resetAt.getTime() + GRACE_MS, now + MIN_DELAY_MS)),
  );
  const expiresInSeconds = Math.ceil((scheduledAt.getTime() - now) / 1_000) + 86_400;
  const row = await runPaseoJson<ScheduleRow>(
    [
      "heartbeat",
      "create",
      RESUME_PROMPT,
      "--cron",
      cronAt(scheduledAt),
      "--timezone",
      "UTC",
      "--name",
      `chat-resume-${agentId}`,
      "--max-runs",
      "1",
      "--expires-in",
      `${expiresInSeconds}s`,
      "--json",
    ],
    agentId,
  );
  if (!row.id) throw new Error("Paseo CLI did not return a schedule ID.");

  const result = {
    scheduleId: row.id,
    scheduledFor: row.nextRunAt ?? scheduledAt.toISOString(),
  };
  return result;
}

export async function scheduleAgentResume(
  input: { agentId: string },
  context: { paseo: PaseoApi },
): Promise<ScheduleResult> {
  const pending = pendingByAgent.get(input.agentId);
  if (pending) return pending;

  const operation = createSchedule(input.agentId, context.paseo);
  pendingByAgent.set(input.agentId, operation);
  try {
    return await operation;
  } finally {
    pendingByAgent.delete(input.agentId);
  }
}
