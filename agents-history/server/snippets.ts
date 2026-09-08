import type { Snippet, SnippetRole } from "../shared/contracts";

/**
 * Turns one matching transcript line into a short, readable snippet. Transcript lines are JSON
 * records, so the text a person wrote or read is pulled out of the provider's shape first and
 * the match is located inside that text; the raw line is the fallback when the record is not
 * JSON, is too large to parse, or matched only inside a field that is not surfaced.
 */

export interface Extracted {
  role: SnippetRole;
  text: string;
  timestamp?: string;
}

export interface MatchLocator {
  (text: string): { index: number; length: number } | null;
}

export type SnippetBody = Omit<Snippet, "file" | "lineNumber">;

/** Where the match was found: in the message text, only in the raw JSON record, or nowhere. */
export type SnippetSource = "text" | "raw" | "none";

export interface ExtractedSnippet {
  body: SnippetBody;
  source: SnippetSource;
}

/** Characters kept on each side of the match. */
const WINDOW_RADIUS = 120;
/** Lines longer than this are never parsed as JSON. */
export const PARSE_CAP = 1024 * 1024;
const ROLE_SNIFF_LENGTH = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Joins the `text` parts of a content array, or returns a plain string content as is. */
function textParts(content: unknown, keys: readonly string[] = ["text"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    for (const key of keys) {
      const value = asString(part[key]);
      if (value) {
        parts.push(value);
        break;
      }
    }
  }
  return parts.join("\n");
}

function classifyClaude(record: Record<string, unknown>): Extracted | null {
  const type = asString(record["type"]);
  const timestamp = asString(record["timestamp"]) ?? undefined;
  const message = isRecord(record["message"]) ? record["message"] : null;
  if (type === "user" && message) {
    const content = message["content"];
    if (typeof content === "string") {
      // Strings starting with a tag are injected notifications, not something the user typed.
      return { role: content.trimStart().startsWith("<") ? "other" : "user", text: content, timestamp };
    }
    if (Array.isArray(content)) {
      const typed: string[] = [];
      const results: string[] = [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part["type"] === "text") {
          const text = asString(part["text"]);
          if (text) typed.push(text);
        } else if (part["type"] === "tool_result") {
          const text = textParts(part["content"]);
          if (text) results.push(text);
        }
      }
      if (typed.length > 0) return { role: "user", text: typed.join("\n"), timestamp };
      if (results.length > 0) return { role: "tool", text: results.join("\n"), timestamp };
    }
    return { role: "other", text: "", timestamp };
  }
  if (type === "assistant" && message) {
    const content = message["content"];
    const spoken: string[] = [];
    const tools: string[] = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        if (part["type"] === "text") {
          const text = asString(part["text"]);
          if (text) spoken.push(text);
        } else if (part["type"] === "tool_use") {
          const name = asString(part["name"]) ?? "tool";
          tools.push(`${name} ${safeStringify(part["input"])}`);
        }
      }
    } else if (typeof content === "string") {
      spoken.push(content);
    }
    if (spoken.length > 0) return { role: "assistant", text: spoken.join("\n"), timestamp };
    if (tools.length > 0) return { role: "tool", text: tools.join("\n"), timestamp };
    return { role: "other", text: "", timestamp };
  }
  if (type === "ai-title") return { role: "other", text: asString(record["aiTitle"]) ?? "", timestamp };
  if (type === "last-prompt") {
    return { role: "other", text: asString(record["lastPrompt"]) ?? "", timestamp };
  }
  return { role: "other", text: "", timestamp };
}

function classifyCodex(record: Record<string, unknown>): Extracted | null {
  const type = asString(record["type"]);
  const timestamp = asString(record["timestamp"]) ?? undefined;
  const payload = isRecord(record["payload"]) ? record["payload"] : null;
  if (!payload) return { role: "other", text: "", timestamp };
  const payloadType = asString(payload["type"]);
  if (type === "response_item") {
    if (payloadType === "message") {
      const role = asString(payload["role"]);
      const text = textParts(payload["content"]);
      if (role === "user") return { role: "user", text, timestamp };
      if (role === "assistant") return { role: "assistant", text, timestamp };
      return { role: "other", text, timestamp };
    }
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const name = asString(payload["name"]) ?? "tool";
      const args = payload["arguments"] ?? payload["input"];
      return { role: "tool", text: `${name} ${typeof args === "string" ? args : safeStringify(args)}`, timestamp };
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return { role: "tool", text: textParts(payload["output"]), timestamp };
    }
    return { role: "other", text: "", timestamp };
  }
  if (type === "event_msg") {
    if (payloadType === "user_message") {
      return { role: "user", text: asString(payload["message"]) ?? "", timestamp };
    }
    if (payloadType === "agent_message") {
      return { role: "assistant", text: asString(payload["message"]) ?? "", timestamp };
    }
    if (payloadType === "item_completed" && isRecord(payload["item"])) {
      const item = payload["item"];
      const itemType = asString(item["type"]);
      const text = textParts(item["content"]);
      if (itemType === "UserMessage" || itemType === "userMessage") return { role: "user", text, timestamp };
      if (itemType === "AgentMessage" || itemType === "agentMessage") {
        return { role: "assistant", text, timestamp };
      }
    }
    return { role: "other", text: "", timestamp };
  }
  return { role: "other", text: "", timestamp };
}

/** Best-effort extraction for providers whose record shape is not known. */
function classifyGeneric(record: Record<string, unknown>): Extracted {
  const timestamp = asString(record["timestamp"]) ?? undefined;
  const role = asString(record["role"]) ?? asString(record["type"]);
  const message = isRecord(record["message"]) ? record["message"] : record;
  const text = textParts(message["content"] ?? message["text"] ?? record["text"]);
  if (role === "user") return { role: "user", text, timestamp };
  if (role === "assistant") return { role: "assistant", text, timestamp };
  return { role: "other", text, timestamp };
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function classifyLine(raw: string, provider: string): Extracted | null {
  if (raw.length > PARSE_CAP) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (provider) {
    case "claude":
      return classifyClaude(parsed);
    case "codex":
      return classifyCodex(parsed);
    default:
      return classifyGeneric(parsed);
  }
}

/** Reads a role off the first few hundred characters when the line cannot be parsed. */
export function sniffRole(raw: string): SnippetRole {
  const head = raw.slice(0, ROLE_SNIFF_LENGTH);
  const typed = /"type"\s*:\s*"(user|assistant)"/.exec(head);
  const role = /"role"\s*:\s*"(user|assistant)"/.exec(head);
  const found = typed?.[1] ?? role?.[1];
  if (found === "user") return "user";
  if (found === "assistant") return "assistant";
  return "other";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the locator once per search. JavaScript accepts most extended regular expressions;
 * when it rejects one (POSIX classes, back-references), fixed strings still work through a
 * case-folded `indexOf`, and regex queries fall back to the raw window with no highlight.
 */
export function buildLocator(
  query: string,
  options: { regex: boolean; caseSensitive: boolean },
): MatchLocator {
  const flags = options.caseSensitive ? "" : "i";
  try {
    const pattern = new RegExp(options.regex ? query : escapeRegExp(query), flags);
    return (text) => {
      const match = pattern.exec(text);
      return match ? { index: match.index, length: match[0].length } : null;
    };
  } catch {
    if (options.regex) return () => null;
    const needle = options.caseSensitive ? query : query.toLowerCase();
    return (text) => {
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      const index = haystack.indexOf(needle);
      return index === -1 ? null : { index, length: query.length };
    };
  }
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

export function windowAround(
  text: string,
  index: number,
  length: number,
  radius = WINDOW_RADIUS,
): { before: string; match: string; after: string } {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  let before = collapseWhitespace(text.slice(start, index));
  let after = collapseWhitespace(text.slice(index + length, end));
  if (start > 0) before = `…${before.trimStart()}`;
  if (end < text.length) after = `${after.trimEnd()}…`;
  return { before, match: text.slice(index, index + length), after };
}

/** The leading part of a text, whitespace collapsed, for a hit whose position is unknown. */
export function leadingWindow(text: string, radius = WINDOW_RADIUS * 2): string {
  const collapsed = collapseWhitespace(text.trim());
  return collapsed.length > radius ? `${collapsed.slice(0, radius)}…` : collapsed;
}

export function extractSnippet(
  raw: string,
  provider: string,
  locate: MatchLocator,
  clipped: boolean,
): ExtractedSnippet {
  const extracted = clipped ? null : classifyLine(raw, provider);
  const role = extracted?.role ?? sniffRole(raw);
  const extras = {
    ...(extracted?.timestamp ? { timestamp: extracted.timestamp } : {}),
    ...(clipped ? { clipped } : {}),
  };
  const text = extracted?.text ?? "";
  const located = text ? locate(text) : null;
  if (located) {
    return { body: { role, ...windowAround(text, located.index, located.length), ...extras }, source: "text" };
  }
  const rawHit = locate(raw);
  if (rawHit) {
    // The match sits in a record field (branch, directory, ids), not in anything that was said,
    // so it is bookkeeping whoever the record belongs to.
    return { body: { role: "other", ...windowAround(raw, rawHit.index, rawHit.length), ...extras }, source: "raw" };
  }
  return {
    body: { role, before: leadingWindow(text || raw), match: "", after: "", ...extras },
    source: "none",
  };
}
