import { useRpc } from "@getpaseo/plugin";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentMatch,
  DEFAULT_PER_AGENT_LIMIT,
  MAX_SEARCH_AGENTS,
  type SearchResult,
  searchHistory,
} from "../shared/contracts";

/**
 * Runs the transcript grep for the current search text. Typing is debounced so the daemon is
 * not asked on every keystroke; Enter flushes immediately. The agent list is folded into a
 * short signature for the query key, since two thousand ids make a poor cache key.
 */

const DEBOUNCE_MS = 400;
/** Shortest search text that triggers a grep. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Agents the static filters keep and whose transcripts exist on disk. */
  agentIds: readonly string[];
}

export class SearchRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function signature(ids: readonly string[]): string {
  let hash = 0;
  for (const id of ids) {
    for (let index = 0; index < id.length; index++) {
      hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
    }
    hash = (Math.imul(hash, 31) + 44) | 0;
  }
  return `${ids.length}:${(hash >>> 0).toString(36)}`;
}

function randomKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isSearchable(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH;
}

export function useHistorySearch(hostId: string, options: SearchOptions) {
  const search = useRpc(searchHistory);
  const clientKey = useRef<string>(randomKey()).current;
  const [debouncedQuery, setDebouncedQuery] = useState(options.query);

  useEffect(() => {
    if (options.query === debouncedQuery) return;
    const timer = setTimeout(() => setDebouncedQuery(options.query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [debouncedQuery, options.query]);

  const flush = useCallback(() => setDebouncedQuery(options.query), [options.query]);

  const agentIds = useMemo(
    () => (options.agentIds.length > MAX_SEARCH_AGENTS ? options.agentIds.slice(0, MAX_SEARCH_AGENTS) : options.agentIds),
    [options.agentIds],
  );
  const capped = options.agentIds.length > MAX_SEARCH_AGENTS;
  const enabled = isSearchable(debouncedQuery) && agentIds.length > 0;

  const query = useQuery({
    queryKey: [
      "agents-history",
      "search",
      hostId,
      debouncedQuery,
      options.regex,
      options.caseSensitive,
      signature(agentIds),
    ] as const,
    queryFn: async (): Promise<SearchResult> => {
      const result = await search({
        query: debouncedQuery,
        regex: options.regex,
        caseSensitive: options.caseSensitive,
        agentIds: [...agentIds],
        perAgentLimit: DEFAULT_PER_AGENT_LIMIT,
        clientKey,
      });
      // A superseded or refused answer must not be cached as the result for this text.
      if (result.error && (result.error.code === "superseded" || result.error.code === "busy")) {
        throw new SearchRequestError(result.error.code, result.error.message);
      }
      return result;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: (count, error) => error instanceof SearchRequestError && error.code === "busy" && count < 2,
    retryDelay: 1_000,
  });

  const matches = useMemo<ReadonlyMap<string, AgentMatch> | null>(() => {
    if (!enabled || !query.data) return null;
    return new Map(query.data.matches.map((match) => [match.agentId, match]));
  }, [enabled, query.data]);

  const waiting = isSearchable(options.query) && (options.query !== debouncedQuery || query.isFetching);
  const errorMessage = query.isError
    ? query.error instanceof Error
      ? query.error.message
      : String(query.error)
    : query.data?.error && enabled
      ? query.data.error.message
      : null;

  return {
    /** Results keyed by agent id, or `null` while nothing has been answered for this text. */
    matches,
    result: enabled ? (query.data ?? null) : null,
    waiting,
    error: errorMessage,
    capped,
    flush,
  };
}
