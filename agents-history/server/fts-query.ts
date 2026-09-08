/**
 * Turns free text into an FTS5 MATCH expression and reads the highlight markers that
 * `snippet()` and `highlight()` put around matched terms back out.
 */

const MAX_TERMS = 16;
/** Start and end of a highlighted term inside snippet()/highlight() output (SOH and STX). */
export const MARK_START = String.fromCharCode(1);
export const MARK_END = String.fromCharCode(2);
const MARKERS = new RegExp(`[${MARK_START}${MARK_END}]`, "g");

export function tokenizeQuery(query: string): string[] {
  const terms: string[] = [];
  for (const raw of query.split(/\s+/)) {
    // Quotes and the FTS5 operators have no meaning here; every term is quoted below.
    const term = raw.replace(/["*]/g, "").trim();
    if (term.length === 0) continue;
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    terms.push(term);
    if (terms.length === MAX_TERMS) break;
  }
  return terms;
}

/**
 * Every term is quoted so hyphens, dots, and slashes tokenise inside the phrase instead of being
 * read as syntax; the last term may match as a prefix so the list fills while typing.
 */
export function buildMatchExpression(
  terms: readonly string[],
  options: { operator: "AND" | "OR"; prefixLast: boolean },
): string | null {
  if (terms.length === 0) return null;
  return terms
    .map((term, index) => {
      const quoted = `"${term.replace(/"/g, '""')}"`;
      const last = index === terms.length - 1;
      return options.prefixLast && last && term.length >= 2 ? `${quoted}*` : quoted;
    })
    .join(` ${options.operator} `);
}

function stripMarkers(value: string): string {
  return value.replace(MARKERS, "");
}

/** The first highlighted term becomes the bold match; other highlights fall back to plain text. */
export function splitSnippetMarkers(snippet: string): { before: string; match: string; after: string } {
  const start = snippet.indexOf(MARK_START);
  const end = start === -1 ? -1 : snippet.indexOf(MARK_END, start + 1);
  if (start === -1 || end === -1) return { before: stripMarkers(snippet), match: "", after: "" };
  return {
    before: stripMarkers(snippet.slice(0, start)),
    match: snippet.slice(start + 1, end),
    after: stripMarkers(snippet.slice(end + 1)),
  };
}

export function hasMarker(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes(MARK_START);
}
