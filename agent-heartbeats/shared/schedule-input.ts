export interface ParsedScheduleInput {
  cron: string;
  timezone: string | null;
  oneShot: boolean;
  description: string;
  nextRunAt: string;
}

export interface SchedulePreset {
  label: string;
  value: string;
  detail: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { label: "In 15 minutes", value: "in 15 minutes", detail: "One run" },
  { label: "In 1 hour", value: "in 1 hour", detail: "One run" },
  { label: "Every 5 minutes", value: "every 5 minutes", detail: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "every 15 minutes", detail: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "every 30 minutes", detail: "*/30 * * * *" },
  { label: "Every hour", value: "every hour", detail: "0 * * * *" },
  { label: "Every day at 09:00", value: "every day at 9am", detail: "0 9 * * * (UTC)" },
  { label: "Weekdays at 09:00", value: "weekdays at 9am", detail: "0 9 * * 1-5 (UTC)" },
];

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  five: 5,
  ten: 10,
  fifteen: 15,
  thirty: 30,
};

const BOUNDS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
] as const;

function parseNumber(source: string): number | null {
  const word = WORD_NUMBERS[source];
  if (word !== undefined) return word;
  if (!/^\d+$/.test(source)) return null;
  const number = Number.parseInt(source, 10);
  return Number.isSafeInteger(number) ? number : null;
}

function durationMs(amount: number, unit: string): number {
  const hours = /^(?:h|hr|hrs|hour|hours)$/.test(unit);
  return amount * (hours ? 60 * 60_000 : 60_000);
}

function cronForInterval(milliseconds: number): string | null {
  const minutes = milliseconds / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes % 60 !== 0) return null;
  const hours = minutes / 60;
  if (hours < 24 && 24 % hours === 0) return `0 */${hours} * * *`;
  if (hours === 24) return "0 0 * * *";
  return null;
}

function oneShotCron(target: Date): string {
  return `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`;
}

function startOfNextMinute(date: Date): Date {
  const next = new Date(date);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next;
}

function ceilToMinute(date: Date): Date {
  const result = new Date(date);
  if (result.getUTCSeconds() === 0 && result.getUTCMilliseconds() === 0) return result;
  result.setUTCSeconds(0, 0);
  result.setUTCMinutes(result.getUTCMinutes() + 1);
  return result;
}

function allowedValues(source: string, bounds: (typeof BOUNDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const rawPart of source.split(",")) {
    const parts = rawPart.trim().split("/");
    if (parts.length > 2) throw new Error(`Invalid cron ${bounds.name} step`);
    const [base, stepSource] = parts;
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (
      !Number.isInteger(step) ||
      step <= 0 ||
      (stepSource !== undefined && String(step) !== stepSource)
    ) {
      throw new Error(`Invalid cron ${bounds.name} step`);
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = bounds.min;
      end = bounds.max;
    } else {
      const range = base.match(/^(\d+)-(\d+)$/);
      if (range) {
        start = Number.parseInt(range[1], 10);
        end = Number.parseInt(range[2], 10);
      } else if (/^\d+$/.test(base)) {
        start = Number.parseInt(base, 10);
        end = start;
      } else {
        throw new Error(`Invalid cron ${bounds.name} value`);
      }
    }
    if (start < bounds.min || end > bounds.max || start > end) {
      throw new Error(`Invalid cron ${bounds.name} range`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`Invalid cron ${bounds.name} field`);
  return values;
}

function parseCron(expression: string): readonly Set<number>[] {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5)
    throw new Error(
      "Enter a duration, a phrase such as ‘every 15 minutes’, or a five-field cron expression.",
    );
  return fields.map((field, index) => allowedValues(field, BOUNDS[index]));
}

export function nextCronRun(expression: string, after: Date): Date {
  const fields = parseCron(expression);
  let cursor = startOfNextMinute(after);
  for (let index = 0; index < 366 * 24 * 60; index += 1) {
    if (
      fields[0].has(cursor.getUTCMinutes()) &&
      fields[1].has(cursor.getUTCHours()) &&
      fields[2].has(cursor.getUTCDate()) &&
      fields[3].has(cursor.getUTCMonth() + 1) &&
      fields[4].has(cursor.getUTCDay())
    )
      return cursor;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  throw new Error("This cron expression has no run time in the next year.");
}

function intervalDescription(milliseconds: number): string {
  const minutes = milliseconds / 60_000;
  if (minutes === 60) return "Every hour";
  if (minutes === 24 * 60) return "Every day";
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export function parseScheduleInput(source: string, now = new Date()): ParsedScheduleInput {
  const normalized = source.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) throw new Error("Enter when this heartbeat should run.");

  if (normalized === "hourly" || normalized === "every hour") {
    const cron = "0 * * * *";
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: "Every hour",
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }
  if (normalized === "daily" || normalized === "every day" || normalized === "every day at 9am") {
    const cron = normalized.endsWith("9am") ? "0 9 * * *" : "0 0 * * *";
    const description = normalized.endsWith("9am")
      ? "Every day at 09:00 UTC"
      : "Every day at 00:00 UTC";
    return {
      cron,
      timezone: null,
      oneShot: false,
      description,
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }
  if (normalized === "weekdays at 9am") {
    const cron = "0 9 * * 1-5";
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: "Weekdays at 09:00 UTC",
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }

  const recurring = normalized.match(
    /^every\s+(\d+|[a-z]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/,
  );
  if (recurring) {
    const amount = parseNumber(recurring[1]);
    if (!amount || amount <= 0) throw new Error("The recurring interval must be positive.");
    const milliseconds = durationMs(amount, recurring[2]);
    const cron = cronForInterval(milliseconds);
    if (!cron)
      throw new Error(
        "That interval cannot be represented exactly by five-field cron. Try 5, 10, 15, 20, or 30 minutes; or 1, 2, 3, 4, 6, 8, 12, or 24 hours.",
      );
    return {
      cron,
      timezone: null,
      oneShot: false,
      description: intervalDescription(milliseconds),
      nextRunAt: nextCronRun(cron, now).toISOString(),
    };
  }

  const oneShot = normalized.match(
    /^(?:in\s+)?(\d+|[a-z]+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/,
  );
  if (oneShot) {
    const amount = parseNumber(oneShot[1]);
    if (!amount || amount <= 0) throw new Error("The delay must be positive.");
    const milliseconds = durationMs(amount, oneShot[2]);
    const minimum = now.getTime() + milliseconds;
    const target = ceilToMinute(new Date(minimum));
    if (!Number.isFinite(target.getTime())) throw new Error("That delay is too large.");
    const cron = oneShotCron(target);
    if (nextCronRun(cron, now).getTime() !== target.getTime()) {
      throw new Error("One-shot delays must fall within the next year.");
    }
    return {
      cron,
      timezone: "UTC",
      oneShot: true,
      description: `Once, ${target.toLocaleString()}`,
      nextRunAt: target.toISOString(),
    };
  }

  const cron = source.trim().replace(/\s+/g, " ");
  const next = nextCronRun(cron, now);
  return {
    cron,
    timezone: null,
    oneShot: false,
    description: describeCron(cron),
    nextRunAt: next.toISOString(),
  };
}

export function describeCron(cron: string): string {
  const minuteStep = cron.match(/^\*\/(\d+) \* \* \* \*$/);
  if (minuteStep) return `Every ${minuteStep[1]} minutes`;
  const hourStep = cron.match(/^0 \*\/(\d+) \* \* \*$/);
  if (hourStep) return `Every ${hourStep[1]} hours`;
  if (cron === "0 * * * *") return "Every hour";
  if (cron === "0 0 * * *") return "Every day at 00:00";
  if (cron === "0 9 * * *") return "Every day at 09:00";
  if (cron === "0 9 * * 1-5") return "Weekdays at 09:00";
  return "Custom cron";
}
