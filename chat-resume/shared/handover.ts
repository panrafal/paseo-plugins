export const HANDOVER_SOURCE_LABEL = "chat-resume.source-agent";

/** Prefer these over ACP catalog fillers when handing over from an exhausted provider. */
export const HANDOVER_PROVIDER_ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "copilot",
  "gemini",
] as const;

export function nextReadyProvider<T extends { provider: string; status: string; enabled: boolean }>(
  entries: readonly T[],
  currentProvider: string,
): T | null {
  const ready = entries.filter(
    (entry) => entry.enabled && entry.status === "ready" && entry.provider !== currentProvider,
  );
  if (ready.length === 0) return null;
  for (const provider of HANDOVER_PROVIDER_ORDER) {
    const match = ready.find((entry) => entry.provider === provider);
    if (match) return match;
  }
  const currentIndex = entries.findIndex((entry) => entry.provider === currentProvider);
  for (let offset = 1; offset <= entries.length; offset += 1) {
    const index = currentIndex < 0 ? offset - 1 : (currentIndex + offset) % entries.length;
    const entry = entries[index];
    if (entry && ready.includes(entry)) return entry;
  }
  return ready[0] ?? null;
}

export interface SelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export function buildHandoverPrompt(sourceAgentId: string): string {
  return `Continue the work of Paseo agent ${sourceAgentId}. Do not start over.

Recover its context with the Paseo CLI before acting:
- \`paseo inspect ${sourceAgentId} --json\` shows its provider, model, status, and runtime settings.
- \`paseo logs ${sourceAgentId}\` reads its chat and tool timeline.
- \`paseo logs ${sourceAgentId} --tail 200\` focuses on its latest work.

Then inspect the current workspace and diff, identify the unfinished work, continue it, and verify the result.`;
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function thinkingRank(option: SelectOption): number | null {
  const value = `${option.id} ${option.label}`.toLowerCase();
  if (/\b(?:off|none|minimal)\b/.test(value)) return 0;
  if (/\blow\b/.test(value)) return 1;
  if (/\b(?:medium|normal|standard)\b/.test(value)) return 2;
  if (/\bhigh\b/.test(value) && !/\b(?:extra|x)[ -]?high\b/.test(value)) return 3;
  if (/\b(?:extra[ -]?high|xhigh|max)\b/.test(value)) return 4;
  if (/\bultra\b/.test(value)) return 5;
  return null;
}

export function similarThinkingOption(
  sourceId: string | null | undefined,
  targetOptions: readonly SelectOption[],
): string | undefined {
  if (targetOptions.length === 0) return undefined;
  const exact = sourceId
    ? targetOptions.find((option) => normalized(option.id) === normalized(sourceId))
    : undefined;
  if (exact) return exact.id;

  const sourceRank = sourceId ? thinkingRank({ id: sourceId, label: sourceId }) : null;
  if (sourceRank !== null) {
    const ranked = targetOptions
      .map((option) => ({ option, rank: thinkingRank(option) }))
      .filter((entry): entry is { option: SelectOption; rank: number } => entry.rank !== null)
      .sort((left, right) => Math.abs(left.rank - sourceRank) - Math.abs(right.rank - sourceRank));
    if (ranked[0]) return ranked[0].option.id;
  }
  return targetOptions.find((option) => option.isDefault)?.id;
}

export function similarMode(
  sourceModeId: string | null | undefined,
  targetModes: readonly SelectOption[],
  targetDefaultModeId?: string | null,
): string | undefined {
  if (targetModes.length === 0) return undefined;
  if (sourceModeId) {
    const exact = targetModes.find((mode) => normalized(mode.id) === normalized(sourceModeId));
    if (exact) return exact.id;

    const sourcePlans = /plan/i.test(sourceModeId);
    const semantic = targetModes.find((mode) => /plan/i.test(`${mode.id} ${mode.label}`) === sourcePlans);
    if (semantic) return semantic.id;
  }
  return targetDefaultModeId ?? targetModes.find((mode) => mode.isDefault)?.id;
}
