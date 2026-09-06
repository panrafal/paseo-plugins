import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const RUN_STATUSES = ["running", "succeeded", "failed"] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ScheduleTargetTypeSchema = z.enum(["agent", "new-agent"]);
export type ScheduleTargetType = z.infer<typeof ScheduleTargetTypeSchema>;

export const StatusCountsSchema = z.object({
  running: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type StatusCounts = z.infer<typeof StatusCountsSchema>;

/** One schedule as the feed needs it: identity, cadence, and how its runs went. */
export const ScheduleSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** `agent` schedules are heartbeats on an existing agent; `new-agent` ones spawn a workspace. */
  targetType: ScheduleTargetTypeSchema,
  status: z.enum(["active", "paused", "completed"]),
  /** Human-readable cadence, e.g. `0 9 * * 1 (Europe/Warsaw)` or `every 30m`. */
  cadence: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  runCount: z.number().int().nonnegative(),
  counts: StatusCountsSchema,
  provider: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Title the schedule gives the agents it creates, when configured. */
  title: z.string().nullable(),
});
export type ScheduleSummary = z.infer<typeof ScheduleSummarySchema>;

/** The agent a run created (or, for heartbeats, targeted), as far as the daemon still knows it. */
export const RunAgentSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  archivedAt: z.string().nullable(),
  /** False when the daemon no longer lists the agent at all; only `id` is meaningful then. */
  known: z.boolean(),
});
export type RunAgent = z.infer<typeof RunAgentSchema>;

export const RunWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  branch: z.string().nullable(),
  projectId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  /** False when the workspace registry has no record; only `id` is meaningful then. */
  known: z.boolean(),
});
export type RunWorkspace = z.infer<typeof RunWorkspaceSchema>;

export const RunPullRequestSchema = z.object({
  url: z.string(),
  number: z.number().int().positive().nullable(),
  title: z.string().nullable(),
  state: z.enum(["open", "merged", "closed"]).nullable(),
  /** Where the link came from; the output is a heuristic, the others are the daemon's word. */
  source: z.enum(["workspace", "archive", "output"]),
});
export type RunPullRequest = z.infer<typeof RunPullRequestSchema>;

export const RunRowSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  scheduleName: z.string().nullable(),
  targetType: ScheduleTargetTypeSchema,
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: RunStatusSchema,
  /** The agent's final response as the daemon recorded it; null while running or when lost. */
  output: z.string().nullable(),
  /** True when `output` was cut to the server's per-run ceiling. */
  outputTruncated: z.boolean(),
  error: z.string().nullable(),
  agent: RunAgentSchema.nullable(),
  workspace: RunWorkspaceSchema.nullable(),
  /** The pull request the run's workspace carries, or the first one its output links to. */
  pullRequest: RunPullRequestSchema.nullable(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

export const DEFAULT_RUN_LIMIT = 500;
export const MAX_RUN_LIMIT = 2000;

/**
 * Every run of every schedule on the daemon, newest first, joined with what the daemon still
 * knows about the agent and workspace each run produced. Heartbeats (schedules that prompt an
 * existing agent) are left out unless asked for.
 */
export const listScheduleRuns = defineRpc({
  name: "schedule-runs.list",
  input: z.object({
    includeHeartbeats: z.boolean().optional(),
    limit: z.number().int().positive().max(MAX_RUN_LIMIT).optional(),
  }),
  output: z.object({
    schedules: z.array(ScheduleSummarySchema),
    runs: z.array(RunRowSchema),
    /** True when more runs exist than `limit` allowed. */
    truncated: z.boolean(),
    generatedAt: z.string(),
  }),
});
