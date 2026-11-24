/**
 * Display-name rules (docs/spec/06-auth.md §5.1): normalisation, length in graphemes and code
 * points, and the rejected characters and patterns that discourage spam and impersonation.
 */

export type DisplayNameResult =
  { readonly ok: true; readonly name: string } | { readonly ok: false; readonly reason: string };

const MAX_GRAPHEMES = 24;
const MAX_CODE_POINTS = 64;
const MAX_COMBINING_MARKS = 2;

/**
 * Control (tabs and line breaks included), bidi override/isolate and zero-width characters
 * (06 §5.1). The zero-width joiner U+200D is allowed only inside an emoji sequence (below).
 */
const FORBIDDEN_CHARACTERS =
  /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}\u{200C}\u{200E}\u{200F}\u{FEFF}]/u;
/**
 * A joiner between two emoji code points, as in family or flag sequences: the left one may carry a
 * skin-tone modifier or the emoji variation selector (06 §5.1).
 */
const EMOJI_JOINER =
  /\p{Extended_Pictographic}[\p{Emoji_Modifier}\u{FE0F}]?\u{200D}(?=\p{Extended_Pictographic})/gu;
const URL_LIKE = /:\/\/|www\.|@/iu;
const DOMAIN_LIKE = /\p{L}\.\p{L}{2,}/iu;
const LONG_DIGIT_RUN = /\p{Nd}{7}/u;
const RESERVED_WORDS = ["admin", "support", "official", "staff"];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * NFC, trimmed, runs of space separators collapsed to single spaces. Tabs and line breaks are
 * control characters, which validation refuses, so they are not collapsed here.
 */
export function normaliseDisplayName(input: string): string {
  return input
    .normalize("NFC")
    .trim()
    .replace(/\p{Zs}+/gu, " ");
}

/** Validates a display name (also used for AI accounts and token names later, 06 §8). */
export function validateDisplayName(input: string, appName: string): DisplayNameResult {
  if (FORBIDDEN_CHARACTERS.test(input)) return { ok: false, reason: "characters" };
  if (input.replace(EMOJI_JOINER, "").includes("\u{200D}")) {
    return { ok: false, reason: "characters" };
  }
  const name = normaliseDisplayName(input);
  const graphemes = Array.from(segmenter.segment(name), (part) => part.segment);
  if (graphemes.length < 1 || graphemes.length > MAX_GRAPHEMES) {
    return { ok: false, reason: "length" };
  }
  if (Array.from(name).length > MAX_CODE_POINTS) return { ok: false, reason: "length" };
  if (graphemes.some((g) => (g.match(/\p{M}/gu) ?? []).length > MAX_COMBINING_MARKS)) {
    return { ok: false, reason: "combining" };
  }
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
