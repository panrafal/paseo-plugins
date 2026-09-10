const EXHAUSTED_PATTERNS = [
  /(?:usage|rate|request|token) limit (?:has been )?(?:reached|exceeded|exhausted|hit)/i,
  /(?:reached|exceeded|exhausted|hit) (?:your |the )?(?:usage|rate|request|token) limit/i,
  /(?:insufficient|exhausted) (?:quota|credits?)/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
  /quota limits?/i,
  /(?:you(?:'ve| have)\s+)?hit your.{0,40}limit/i,
  /(?:monthly|weekly|daily) (?:spend |usage )?limit/i,
  /(?:spend|session) limit/i,
  /too many requests/i,
  /(?:no|0) (?:weighted )?(?:tokens?|requests?|credits?) (?:remaining|left)/i,
  /token allowance/i,
  /resource[_ ]exhausted/i,
];

const CONTEXT_LIMIT_PATTERN = /(?:context|input|output).{0,24}(?:length|window|tokens?).{0,24}(?:limit|maximum|exceed)/i;

export const CONTINUE_PROMPT =
  "The provider token allowance should now be renewed. Continue the unfinished work from the previous turn. Review the latest conversation and workspace state before acting.";

export function isUsageExhaustedError(error: string | null | undefined): error is string {
  if (!error || CONTEXT_LIMIT_PATTERN.test(error)) return false;
  return EXHAUSTED_PATTERNS.some((pattern) => pattern.test(error));
}

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  s: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
};

export interface UsageSource {
  text: string | null | undefined;
  observedAt: string | Date;
}

export interface UsageMatch {
  exhausted: boolean;
  resetAt: Date | null;
}

export type ResumeAction = "continue" | "schedule";

export function resumeAction(resetAt: Date | null, now: Date | number = Date.now()): ResumeAction {
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!resetAt || resetAt.getTime() <= nowMs) return "continue";
  return "schedule";
}

export function usageFromSources(sources: readonly UsageSource[]): UsageMatch {
  let exhausted = false;
  let resetAt: Date | null = null;
  for (const source of sources) {
    if (!isUsageExhaustedError(source.text)) continue;
    exhausted = true;
    const next = usageResetAt(source.text, source.observedAt);
    if (next && !resetAt) resetAt = next;
  }
  return { exhausted, resetAt };
}

function relativeResetAt(error: string, observedAt: Date): Date | null {
  const marker = /(?:try again|reset(?:s)?|retry|available again|renews?)\s+(?:in|after)\s+/i.exec(error);
  if (!marker) return null;

  const suffix = error.slice(marker.index + marker[0].length, marker.index + marker[0].length + 100);
  const units = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|[smh])\b/gi;
  let totalMs = 0;
  let match: RegExpExecArray | null;
  while ((match = units.exec(suffix))) {
    totalMs += Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
  }
  return totalMs > 0 ? new Date(observedAt.getTime() + totalMs) : null;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function partsInTimeZone(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zonedDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMs = (date: Date) => {
    const parts = partsInTimeZone(date, timeZone);
    return (
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      date.getTime()
    );
  };
  const corrected = utcGuess - offsetMs(new Date(utcGuess));
  return new Date(utcGuess - offsetMs(new Date(corrected)));
}

function nextClockInTimeZone(observedAt: Date, hour: number, minute: number, timeZone: string): Date {
  const parts = partsInTimeZone(observedAt, timeZone);
  let candidate = zonedDate(timeZone, parts.year, parts.month, parts.day, hour, minute);
  if (candidate.getTime() <= observedAt.getTime()) {
    const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12, 0, 0));
    candidate = zonedDate(
      timeZone,
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      hour,
      minute,
    );
  }
  return candidate;
}

function clockResetAt(error: string, observedAt: Date): Date | null {
  const clock =
    /(?:reset(?:s)?|renews?|try again|available again)(?:\s+(?:at|after|until))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)]+)\))?/i.exec(
      error,
    );
  if (!clock) return null;

  let hour = Number(clock[1]) % 12;
  if (clock[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(clock[2] ?? 0);
  const timeZone = clock[4]?.trim();
  if (timeZone && isValidTimeZone(timeZone)) {
    return nextClockInTimeZone(observedAt, hour, minute, timeZone);
  }

  const candidate = new Date(observedAt);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= observedAt.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function absoluteResetAt(error: string, observedAt: Date): Date | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/i.exec(error);
  if (iso) {
    const parsed = new Date(iso[0]);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const clock = clockResetAt(error, observedAt);
  if (clock) return clock;

  const dated = /(?:reset(?:s)?|renews?|try again|available again)(?:\s+(?:at|on|after))?\s+([^\n.]{4,80})/i.exec(
    error,
  );
  if (dated) {
    const parsedMs = Date.parse(dated[1].trim());
    if (!Number.isNaN(parsedMs)) return new Date(parsedMs);
  }

  return null;
}

/** Extracts the renewal time from a usage-limit failure or quota assistant message. */
export function usageResetAt(
  error: string | null | undefined,
  observedAt: string | Date,
): Date | null {
  if (!isUsageExhaustedError(error)) return null;
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return null;
  return relativeResetAt(error, observed) ?? absoluteResetAt(error, observed);
}
