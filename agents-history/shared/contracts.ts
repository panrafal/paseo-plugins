import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Wire contracts between the surface and the plugin's daemon-side entry. The list call returns
 * the complete census the daemon keeps on disk (archived workspaces and agents included); the
 * search call ranks the agents' provider transcripts through the SQLite FTS5 index (or greps
 * the raw files in regex mode) and returns a few matching snippets per agent. Nothing here can carry an agent's persistence metadata.
 */

export const AGENT_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
  "unknown",
] as const;
export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const TranscriptReasonSchema = z.enum([
  "no-session",
  "unsupported-provider",
  "file-missing",
]);
export type TranscriptReason = z.infer<typeof TranscriptReasonSchema>;

export const TranscriptInfoSchema = z.object({
  searchable: z.boolean(),
  reason: TranscriptReasonSchema.optional(),
  fileCount: z.number().int().nonnegative(),
});
export type TranscriptInfo = z.infer<typeof TranscriptInfoSchema>;

export const ProjectSummarySchema = z.object({
  projectId: z.string(),
  displayName: z.string().nullable(),
  customName: z.string().nullable(),
  rootPath: z.string(),
  kind: z.string().nullable(),
  archivedAt: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const WorkspaceSummarySchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  cwd: z.string(),
  kind: z.string().nullable(),
  displayName: z.string().nullable(),
  title: z.string().nullable(),
  branch: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  pinnedAt: z.string().nullable(),
  autoArchivedChangeRequestUrl: z.string().nullable(),
  labels: z.array(z.string()),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const AgentSummarySchema = z.object({
  id: z.string(),
  /** Null when the agent could not be joined to any workspace record. */
  workspaceId: z.string().nullable(),
  provider: z.string(),
  title: z.string().nullable(),
  status: AgentStatusSchema,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string().nullable(),
  model: z.string().nullable(),
  transcript: TranscriptInfoSchema,
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const listHistory = defineRpc({
  name: "agents-history.list",
  input: z.object({}),
  output: z.object({
    projects: z.array(ProjectSummarySchema),
    workspaces: z.array(WorkspaceSummarySchema),
    agents: z.array(AgentSummarySchema),
    generatedAt: z.string(),
  }),
});
export type HistoryList = z.infer<typeof listHistory.output>;

export const SNIPPET_ROLES = ["user", "assistant", "tool", "other"] as const;
export const SnippetRoleSchema = z.enum(SNIPPET_ROLES);
export type SnippetRole = z.infer<typeof SnippetRoleSchema>;

export const SnippetSchema = z.object({
  file: z.enum(["main", "subagent"]),
  lineNumber: z.number().int().positive(),
  role: SnippetRoleSchema,
  before: z.string(),
  match: z.string(),
  after: z.string(),
  timestamp: z.string().optional(),
  /** The transcript line exceeded the per-line cap; the snippet may be partial. */
  clipped: z.boolean().optional(),
  /** Relevance of this chunk in ranked mode; higher is better. */
  score: z.number().optional(),
});
export type Snippet = z.infer<typeof SnippetSchema>;

export const AgentMatchSchema = z.object({
  agentId: z.string(),
  snippets: z.array(SnippetSchema),
  /** More matching lines exist than were returned. */
  truncated: z.boolean(),
  /** Distinct matching lines seen, bounded by the per-file grep limit. */
  hitCount: z.number().int().nonnegative(),
  /** Combined relevance of the agent in ranked mode; higher is better. */
  score: z.number().optional(),
  /** The query matched the agent's or workspace's metadata (title, branch, path, ...). */
  metadataHit: z.boolean().optional(),
  metadataFields: z.array(z.string()).optional(),
});
export type AgentMatch = z.infer<typeof AgentMatchSchema>;

export const SearchErrorSchema = z.object({
  code: z.enum([
    "invalid-regex",
    "invalid-query",
    "timeout",
    "superseded",
    "busy",
    "grep-failed",
    "index-failed",
  ]),
  message: z.string(),
});
export type SearchError = z.infer<typeof SearchErrorSchema>;

export const SEARCH_MODES = ["ranked", "regex"] as const;
export const SearchModeSchema = z.enum(SEARCH_MODES);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const INDEX_STATES = ["unavailable", "idle", "planning", "indexing", "housekeeping"] as const;
export const IndexStatusSchema = z.object({
  /** `node:sqlite` with FTS5 is usable on the daemon host. */
  available: z.boolean(),
  reason: z.enum(["no-sqlite", "fts5-missing", "open-failed"]).optional(),
  state: z.enum(INDEX_STATES),
  indexedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  indexedAgents: z.number().int().nonnegative(),
  totalAgents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  /** Some transcript has bytes not indexed yet, or no plan has run since the census changed. */
  stale: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type IndexStatus = z.infer<typeof IndexStatusSchema>;

export const indexStatus = defineRpc({
  name: "agents-history.index-status",
  input: z.object({}),
  output: IndexStatusSchema,
});

export const MAX_SEARCH_AGENTS = 2000;
export const DEFAULT_PER_AGENT_LIMIT = 3;

export const searchHistory = defineRpc({
  name: "agents-history.search",
  input: z.object({
    /** Not trimmed: leading or trailing spaces can be intentional. */
    query: z.string().min(1).max(500),
    /** Ranked full-text search over the index, or a grep over the raw files. `regex` forces grep. */
    mode: SearchModeSchema.default("ranked"),
    /** Extended regular expression instead of a fixed string. */
    regex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    agentIds: z.array(z.string().min(1)).min(1).max(MAX_SEARCH_AGENTS),
    perAgentLimit: z.number().int().min(1).max(20).default(DEFAULT_PER_AGENT_LIMIT),
    /** Stable per surface mount; a newer search with the same key supersedes the older one. */
    clientKey: z.string().min(1).max(64).optional(),
  }),
  output: z.object({
    matches: z.array(AgentMatchSchema),
    searchedAgents: z.number().int().nonnegative(),
    /** Requested agents that have no transcript on disk. */
    unsearchableAgents: z.array(z.string()),
    durationMs: z.number().nonnegative(),
    /** The global output cap was hit; results may be incomplete. */
    outputTruncated: z.boolean(),
    error: SearchErrorSchema.optional(),
    /** Which engine answered. */
    mode: SearchModeSchema.optional(),
    /** Ranked mode was asked for but grep answered. */
    fallback: z.enum(["no-sqlite", "index-empty"]).optional(),
    /** No agent contained every word, so any word was accepted. */
    relaxed: z.boolean().optional(),
    index: IndexStatusSchema.optional(),
  }),
});
export type SearchResult = z.infer<typeof searchHistory.output>;

export const restoreAgent = defineRpc({
  name: "agents-history.restore-agent",
  input: z.object({ agentId: z.string().uuid() }),
  output: z.object({ agentId: z.string() }),
});
