import type { PaseoApi } from "@getpaseo/client";
import { usePaseo } from "@getpaseo/plugin";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Fallback for a run whose record carries no output: the agent's own transcript, read through
 * the timeline RPC. This works for archived agents too (the daemon reopens them in history
 * mode), but it costs a provider session per agent, so it runs only when the user asks and
 * the result is kept for the rest of the app session.
 */

/** Enough of the tail to reach past trailing tool calls to the last assistant message. */
const TAIL_LIMIT = 40;

type TimelineEntries = Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["timeline"]["refetch"]>>["entries"];

export interface TranscriptState {
  status: "idle" | "loading" | "ready" | "error";
  /** The last assistant message, or null when the transcript holds none. */
  text: string | null;
  error: string | null;
}

const IDLE: TranscriptState = { status: "idle", text: null, error: null };
const LOADING: TranscriptState = { status: "loading", text: null, error: null };

const results = new Map<string, string | null>();

/** The last assistant message in the page, or null when the page has none. */
export function lastAssistantText(entries: TimelineEntries): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const item = entries[index]?.item;
    if (item?.type === "assistant_message" && item.text.trim().length > 0) return item.text;
  }
  return null;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause);
  return text && text !== "undefined" ? text : "Could not read the transcript.";
}

export function useTranscriptOutput(agentId: string | null): {
  state: TranscriptState;
  load(): void;
} {
  const paseo = usePaseo();
  const [state, setState] = useState<TranscriptState>(() => {
    if (agentId && results.has(agentId)) {
      return { status: "ready", text: results.get(agentId) ?? null, error: null };
    }
    return IDLE;
  });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    if (!agentId) return;
    const cached = results.get(agentId);
    if (cached !== undefined) {
      setState({ status: "ready", text: cached, error: null });
      return;
    }
    setState(LOADING);
    void (async () => {
      try {
        const page = await paseo.agents
          .ref(agentId)
          .timeline.refetch({ direction: "tail", limit: TAIL_LIMIT });
        if (page.error) throw new Error(page.error);
        const text = lastAssistantText(page.entries);
        results.set(agentId, text);
        if (aliveRef.current) setState({ status: "ready", text, error: null });
      } catch (cause) {
        if (aliveRef.current) setState({ status: "error", text: null, error: errorMessage(cause) });
      }
    })();
  }, [agentId, paseo]);

  return { state, load };
}
