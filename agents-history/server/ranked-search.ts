import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { AgentMatch, SearchError, Snippet, SnippetRole, searchHistory } from "../shared/contracts";
import type { AgentRecord } from "./census";
import { MARK_END, MARK_START, buildMatchExpression, hasMarker, splitSnippetMarkers, tokenizeQuery } from "./fts-query";
import type { IndexHandle } from "./index-db";
import { META_COLUMNS } from "./index-db";
import { collapseWhitespace } from "./snippets";

/**
 * Ranked search over the FTS5 index. Two queries run: one over what was said, one over the
 * agents' metadata with per-column weights, and the scores are combined per agent so that a hit
 * in a title, branch, or directory outranks a passing mention deep in a transcript.
 */

type SearchInput = RpcInput<typeof searchHistory>;
type SearchOutput = RpcOutput<typeof searchHistory>;

/** Most body rows examined per search; a very common word stops here. */
const BODY_LIMIT = 3000;
/** How many of an agent's best chunks contribute to its score. */
const BODY_TOP = 5;
const BODY_TAIL_WEIGHT = 0.3;
const META_WEIGHT = 5.0;
/** bm25() weights for agent_id (unindexed) then the metadata columns, in table order. */
const META_COLUMN_WEIGHTS = [0, 6, 5, 4, 4, 4, 2, 1.5, 1.5];
const SNIPPET_TOKENS = 20;
const ROLE_RANK: Record<SnippetRole, number> = { user: 0, assistant: 1, tool: 2, other: 3 };

interface BodyRow {
  agent_id: string;
  file_id: number | string;
  line: number | string;
  role: string;
  ts: string | null;
  rank: number;
  snip: string;
}

interface MetaRow {
  agent_id: string;
  rank: number;
  [highlight: string]: unknown;
}

interface AgentScore {
  rels: number[];
  snippets: Snippet[];
  hitCount: number;
  metaRel: number;
  metaFields: string[];
}

const BODY_SQL = `
  SELECT agent_id, file_id, line, role, ts, bm25(chunks) AS rank,
         snippet(chunks, 0, ?3, ?4, '…', ${SNIPPET_TOKENS}) AS snip
  FROM chunks
  WHERE chunks MATCH ?1 AND agent_id IN (SELECT value FROM json_each(?2))
  ORDER BY rank
  LIMIT ${BODY_LIMIT}`;

const META_SQL = `
  SELECT agent_id, bm25(agent_meta, ${META_COLUMN_WEIGHTS.join(", ")}) AS rank,
         ${META_COLUMNS.map((column, index) => `highlight(agent_meta, ${index + 1}, ?3, ?4) AS h_${column}`).join(", ")}
  FROM agent_meta
  WHERE agent_meta MATCH ?1 AND agent_id IN (SELECT value FROM json_each(?2))`;

const KINDS_SQL = "SELECT id, kind FROM files WHERE agent_id IN (SELECT value FROM json_each(?1))";
const SEARCHABLE_SQL = "SELECT DISTINCT agent_id FROM files WHERE agent_id IN (SELECT value FROM json_each(?1))";

function toRole(value: string): SnippetRole {
  return value === "user" || value === "assistant" || value === "tool" ? value : "other";
}

function classifyError(error: unknown): SearchError {
  const message = error instanceof Error ? error.message : String(error);
  if (/fts5: syntax error|no such column|unterminated|malformed MATCH|fts5: phrase/i.test(message)) {
    return { code: "invalid-query", message: "The search text could not be turned into a query." };
  }
  return { code: "index-failed", message: `The search index failed: ${message}` };
}

function activityOf(record: AgentRecord | undefined): number {
  if (!record) return 0;
  return Date.parse(record.lastActivityAt ?? record.updatedAt ?? record.createdAt) || 0;
}

export function rankedSearch(
  input: SearchInput,
  handle: IndexHandle,
  records: ReadonlyMap<string, AgentRecord>,
): SearchOutput {
  const startedAt = Date.now();
  const db = handle.db;
  const ids = JSON.stringify(input.agentIds);
  const terms = tokenizeQuery(input.query);
  const base: SearchOutput = {
    matches: [],
    searchedAgents: 0,
    unsearchableAgents: [],
    durationMs: 0,
    outputTruncated: false,
    mode: "ranked",
  };

  try {
    const searchable = new Set(
      (db.prepare(SEARCHABLE_SQL).all(ids) as { agent_id: string }[]).map((row) => row.agent_id),
    );
    base.searchedAgents = searchable.size;
    base.unsearchableAgents = input.agentIds.filter((id) => !searchable.has(id));

    const andExpression = buildMatchExpression(terms, { operator: "AND", prefixLast: true });
    const orExpression = buildMatchExpression(terms, { operator: "OR", prefixLast: true });
    if (!andExpression || !orExpression) {
      return {
        ...base,
        durationMs: Date.now() - startedAt,
        error: { code: "invalid-query", message: "Type a word to search for." },
      };
    }

    const bodyStatement = db.prepare(BODY_SQL);
    let bodyRows = bodyStatement.all(andExpression, ids, MARK_START, MARK_END) as unknown as BodyRow[];
    let relaxed = false;
    if (bodyRows.length === 0 && terms.length > 1) {
      bodyRows = bodyStatement.all(orExpression, ids, MARK_START, MARK_END) as unknown as BodyRow[];
      relaxed = bodyRows.length > 0;
    }
    const metaRows = db.prepare(META_SQL).all(orExpression, ids, MARK_START, MARK_END) as unknown as MetaRow[];
    const kinds = new Map<number, Snippet["file"]>();
    for (const row of db.prepare(KINDS_SQL).all(ids) as { id: number; kind: string }[]) {
      kinds.set(Number(row.id), row.kind === "subagent" ? "subagent" : "main");
    }

    const agents = new Map<string, AgentScore>();
    const scoreOf = (agentId: string): AgentScore => {
      let entry = agents.get(agentId);
      if (!entry) {
        entry = { rels: [], snippets: [], hitCount: 0, metaRel: 0, metaFields: [] };
        agents.set(agentId, entry);
      }
      return entry;
    };

    for (const row of bodyRows) {
      const entry = scoreOf(row.agent_id);
      const rel = -Number(row.rank);
      entry.hitCount += 1;
      if (entry.rels.length < BODY_TOP) entry.rels.push(rel);
      if (entry.snippets.length < input.perAgentLimit) {
        const parts = splitSnippetMarkers(row.snip);
        entry.snippets.push({
          file: kinds.get(Number(row.file_id)) ?? "main",
          lineNumber: Math.max(1, Number(row.line) || 1),
          role: toRole(row.role),
          before: collapseWhitespace(parts.before),
          match: parts.match,
          after: collapseWhitespace(parts.after),
          ...(row.ts ? { timestamp: row.ts } : {}),
          score: rel,
        });
      }
    }
    for (const row of metaRows) {
      const entry = scoreOf(row.agent_id);
      entry.metaRel = Math.max(entry.metaRel, -Number(row.rank));
      entry.metaFields = META_COLUMNS.filter((column) => hasMarker(row[`h_${column}`] as string | null));
    }

    const matches: (AgentMatch & { score: number })[] = [];
    for (const [agentId, entry] of agents) {
      const [top = 0, ...rest] = entry.rels;
      const bodyScore = top + BODY_TAIL_WEIGHT * rest.reduce((sum, value) => sum + value, 0);
      const score = META_WEIGHT * entry.metaRel + bodyScore;
      // Within an agent, the best-ranked chunks come first; a person's words beat the agent's on ties.
      entry.snippets.sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0) || ROLE_RANK[a.role] - ROLE_RANK[b.role] || a.lineNumber - b.lineNumber,
      );
      matches.push({
        agentId,
        snippets: entry.snippets,
        truncated: entry.hitCount > entry.snippets.length,
        hitCount: entry.hitCount,
        score,
        ...(entry.metaRel > 0 ? { metadataHit: true, metadataFields: entry.metaFields } : {}),
      });
    }
    matches.sort(
      (a, b) => b.score - a.score || activityOf(records.get(b.agentId)) - activityOf(records.get(a.agentId)),
    );

    return {
      ...base,
      matches,
      durationMs: Date.now() - startedAt,
      outputTruncated: bodyRows.length >= BODY_LIMIT,
      ...(relaxed ? { relaxed } : {}),
    };
  } catch (error) {
    return { ...base, durationMs: Date.now() - startedAt, error: classifyError(error) };
  }
}
