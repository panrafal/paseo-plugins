const EXHAUSTED_PATTERNS = [
  /(?:usage|rate|request|token) limit (?:has been )?(?:reached|exceeded|exhausted|hit)/i,
  /(?:reached|exceeded|exhausted|hit) (?:your |the )?(?:usage|rate|request|token) limit/i,
  /(?:insufficient|exhausted) (?:quota|credits?)/i,
  /quota (?:has been )?(?:reached|exceeded|exhausted)/i,
  /quota limits?/i,
  /(?:you(?:'ve| have)\s+)?hit your limit/i,
  /too many requests/i,
  /(?:no|0) (?:weighted )?(?:tokens?|requests?|credits?) (?:remaining|left)/i,
  /token allowance/i,
  /resource[_ ]exhausted/i,
];

const CONTEXT_LIMIT_PATTERN = /(?:context|input|output).{0,24}(?:length|window|tokens?).{0,24}(?:limit|maximum|exceed)/i;

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

function absoluteResetAt(error: string, observedAt: Date): Date | null {
  const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})\b/i.exec(error);
  if (iso) {
    const parsed = new Date(iso[0]);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const dated = /(?:reset(?:s)?|renews?|try again|available again)(?:\s+(?:at|on|after))?\s+([^\n.]{4,80})/i.exec(error);
  if (dated) {
    const parsedMs = Date.parse(dated[1].trim());
    if (!Number.isNaN(parsedMs)) return new Date(parsedMs);
  }

  const clock = /(?:reset(?:s)?|renews?|try again|available again)(?:\s+(?:at|after|until))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(error);
  if (!clock) return null;

  let hour = Number(clock[1]) % 12;
  if (clock[3].toLowerCase() === "pm") hour += 12;
  const candidate = new Date(observedAt);
  candidate.setHours(hour, Number(clock[2] ?? 0), 0, 0);
  if (candidate.getTime() <= observedAt.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

/** Extracts the renewal time from the latest provider failure. */
export function usageResetAt(
  error: string | null | undefined,
  observedAt: string | Date,
): Date | null {
  if (!isUsageExhaustedError(error)) return null;
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (Number.isNaN(observed.getTime())) return null;
  return relativeResetAt(error, observed) ?? absoluteResetAt(error, observed);
}
