/**
 * Display-name rules (docs/spec/06-auth.md §5.1): normalisation, length in graphemes and code
 * points, and the rejected characters and patterns that discourage spam and impersonation.
 */

export type DisplayNameResult =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string };

const MAX_GRAPHEMES = 24;
const MAX_CODE_POINTS = 64;
const MAX_COMBINING_MARKS = 2;

/** Control, bidi override/isolate and zero-width characters (06 §5.1). */
const FORBIDDEN_CHARACTERS = /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200F}\u{FEFF}]/u;
const URL_LIKE = /:\/\/|www\.|@/iu;
const DOMAIN_LIKE = /\p{L}\.\p{L}{2,}/iu;
const LONG_DIGIT_RUN = /\p{Nd}{7}/u;
const RESERVED_WORDS = ["admin", "support", "official", "staff"];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** NFC, trimmed, internal whitespace collapsed to single spaces. */
export function normaliseDisplayName(input: string): string {
  return input.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** Validates a display name (also used for AI accounts and token names later, 06 §8). */
export function validateDisplayName(input: string, appName: string): DisplayNameResult {
  const name = normaliseDisplayName(input);
  const graphemes = Array.from(segmenter.segment(name), (part) => part.segment);
  if (graphemes.length < 1 || graphemes.length > MAX_GRAPHEMES) {
    return { ok: false, reason: "length" };
  }
  if (Array.from(name).length > MAX_CODE_POINTS) return { ok: false, reason: "length" };
  if (graphemes.some((g) => (g.match(/\p{M}/gu) ?? []).length > MAX_COMBINING_MARKS)) {
    return { ok: false, reason: "combining" };
  }
  // Checked on the input: normalising would turn a line break into a space.
  if (FORBIDDEN_CHARACTERS.test(input)) return { ok: false, reason: "characters" };
  if (URL_LIKE.test(name) || DOMAIN_LIKE.test(name)) return { ok: false, reason: "link" };
  if (LONG_DIGIT_RUN.test(name)) return { ok: false, reason: "digits" };
  const lower = name.toLowerCase();
  if (
    [appName.toLowerCase(), ...RESERVED_WORDS].some((word) => word !== "" && lower.includes(word))
  ) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, name };
}
