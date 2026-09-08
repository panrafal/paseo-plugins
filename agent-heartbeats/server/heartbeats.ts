import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import { z } from "zod";
import type {
  createHeartbeat,
  deleteHeartbeat,
  listHeartbeats,
  updateHeartbeat,
} from "../shared/contracts";
import type { Heartbeat } from "../shared/contracts";
import { paseoHome } from "./paseo-home";

const PersistedScheduleSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string(),
  cadence: z.discriminatedUnion("type", [
    z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().optional() }),
    z.object({ type: z.literal("every"), everyMs: z.number().int().positive() }),
  ]),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("agent"), agentId: z.string() }),
    z.object({ type: z.literal("new-agent"), config: z.object({}).passthrough() }),
  ]),
  status: z.enum(["active", "paused", "completed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  runs: z.array(z.object({ id: z.string() }).passthrough()),
});

type PersistedSchedule = z.output<typeof PersistedScheduleSchema>;
type ScheduleMutationInput = RpcInput<typeof createHeartbeat>;

const operations = new Map<string, Promise<unknown>>();

function scheduleDirectory(): string {
  return join(paseoHome(), "schedules");
}

function cadenceCron(schedule: PersistedSchedule): string {
  if (schedule.cadence.type === "cron") return schedule.cadence.expression;
  const minutes = schedule.cadence.everyMs / 60_000;
  if (Number.isInteger(minutes) && minutes > 0 && minutes < 60 && 60 % minutes === 0) {
    return `*/${minutes} * * * *`;
  }
  if (minutes === 60) return "0 * * * *";
  if (Number.isInteger(minutes) && minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
    if (hours === 24) return "0 0 * * *";
  }
  return `every:${schedule.cadence.everyMs}ms`;
}

function toHeartbeat(schedule: PersistedSchedule): Heartbeat {
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    cron: cadenceCron(schedule),
    timezone: schedule.cadence.type === "cron" ? (schedule.cadence.timezone ?? null) : null,
    status: schedule.status === "paused" ? "paused" : "active",
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    expiresAt: schedule.expiresAt,
    maxRuns: schedule.maxRuns,
    runCount: schedule.runs.length,
  };
}

async function readSchedules(): Promise<PersistedSchedule[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(scheduleDirectory(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const schedules: PersistedSchedule[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(scheduleDirectory(), entry.name);
    try {
      const parsed = PersistedScheduleSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (parsed.success) schedules.push(parsed.data);
      else console.warn(`[agent-heartbeats] ignoring invalid schedule file ${entry.name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[agent-heartbeats] could not read schedule file ${entry.name}`);
      }
    }
  }
  return schedules;
}

async function agentSchedules(agentId: string): Promise<PersistedSchedule[]> {
  return (await readSchedules())
    .filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    )
    .sort((left, right) => {
      if (left.nextRunAt && right.nextRunAt) return left.nextRunAt.localeCompare(right.nextRunAt);
      if (left.nextRunAt) return -1;
      if (right.nextRunAt) return 1;
      return left.createdAt.localeCompare(right.createdAt);
    });
}

async function response(agentId: string): Promise<{ heartbeats: Heartbeat[] }> {
  return { heartbeats: (await agentSchedules(agentId)).map(toHeartbeat) };
}

async function requireOwnedHeartbeat(agentId: string, id: string): Promise<PersistedSchedule> {
  const schedule = (await readSchedules()).find((candidate) => candidate.id === id);
  if (!schedule || schedule.status === "completed") throw new Error(`Heartbeat not found: ${id}`);
  if (schedule.target.type !== "agent" || schedule.target.agentId !== agentId) {
    throw new Error(`Heartbeat ${id} does not belong to this agent.`);
  }
  return schedule;
}

function cliError(stdout: string, stderr: string, error: Error): Error {
  try {
    const parsed = JSON.parse(stdout) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return new Error(parsed.error.message);
  } catch {
    // The CLI may fail before its JSON renderer starts.
  }
  const detail = stderr.trim() || error.message;
  return new Error(detail || "The Paseo heartbeat command failed.");
}

function runPaseo(agentId: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "paseo",
      args,
      {
        env: { ...process.env, PASEO_AGENT_ID: agentId },
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(cliError(stdout, stderr, error));
        else resolve(stdout);
      },
    );
  });
}

function createArgs(input: ScheduleMutationInput, name?: string | null): string[] {
  const args = ["heartbeat", "create", "--cron", input.cron];
  if (input.timezone) args.push("--timezone", input.timezone);
  if (name) args.push("--name", name);
  if (input.maxRuns !== null) args.push("--max-runs", String(input.maxRuns));
  args.push("--json", "--", input.prompt);
  return args;
}

async function createForAgent(input: ScheduleMutationInput, name?: string | null): Promise<string> {
  const before = new Set((await agentSchedules(input.agentId)).map((schedule) => schedule.id));
  const stdout = await runPaseo(input.agentId, createArgs(input, name));
  try {
    const parsed = JSON.parse(stdout) as { id?: unknown };
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
  } catch {
    // Fall through to the persisted records, which are authoritative.
  }
  const created = (await agentSchedules(input.agentId)).filter(
    (schedule) => !before.has(schedule.id),
  );
  const newest = created.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (!newest) throw new Error("Paseo created the heartbeat but did not return its identifier.");
  return newest.id;
}

async function enqueue<Result>(agentId: string, operation: () => Promise<Result>): Promise<Result> {
  const previous = operations.get(agentId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  operations.set(agentId, next);
  try {
    return await next;
  } finally {
    if (operations.get(agentId) === next) operations.delete(agentId);
  }
}

export function readHeartbeats(input: RpcInput<typeof listHeartbeats>) {
  return response(input.agentId);
}

export function addHeartbeat(input: RpcInput<typeof createHeartbeat>) {
  return enqueue(input.agentId, async () => {
    await createForAgent(input);
    return response(input.agentId);
  });
}

export function editHeartbeat(input: RpcInput<typeof updateHeartbeat>) {
  return enqueue(input.agentId, async () => {
    const current = await requireOwnedHeartbeat(input.agentId, input.id);
    const currentCron = cadenceCron(current);
    const currentTimezone =
      current.cadence.type === "cron" ? (current.cadence.timezone ?? null) : null;
    const onlyCadenceChanged = current.prompt === input.prompt && current.maxRuns === input.maxRuns;

    if (onlyCadenceChanged) {
      if (currentCron !== input.cron || currentTimezone !== input.timezone) {
        const args = ["heartbeat", "update", input.id, "--cron", input.cron];
        if (input.timezone) args.push("--timezone", input.timezone);
        args.push("--json");
        await runPaseo(input.agentId, args);
      }
      return response(input.agentId);
    }

    const replacementId = await createForAgent(input, current.name);
    try {
      await runPaseo(input.agentId, ["heartbeat", "delete", input.id, "--json"]);
    } catch (error) {
      await runPaseo(input.agentId, ["heartbeat", "delete", replacementId, "--json"]).catch(
        () => undefined,
      );
      throw error;
    }
    return response(input.agentId);
  });
}

export function removeHeartbeat(input: RpcInput<typeof deleteHeartbeat>) {
  return enqueue(input.agentId, async () => {
    await requireOwnedHeartbeat(input.agentId, input.id);
    await runPaseo(input.agentId, ["heartbeat", "delete", input.id, "--json"]);
    return response(input.agentId);
  });
}
