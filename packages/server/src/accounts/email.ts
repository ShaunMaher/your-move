/**
 * A normalised email address (04 conventions: trimmed, Unicode NFC, lower-cased, a pragmatic
 * address shape, at most 254 characters). The brand means only {@link normaliseAddress} can
 * produce one, so `emailId` and lookups can never be fed a raw, unnormalised address — which would
 * silently miss suppression-list entries (M2a review S-9).
 */
declare const normalised: unique symbol;

export type NormalisedEmail = string & { readonly [normalised]: true };

/** The longest address stored (04 conventions; RFC 5321's path limit). */
export const MAX_EMAIL_LENGTH = 254;

/**
 * The pragmatic address shape (04): a local part and a domain of at least two dot-separated labels,
 * with no whitespace, control characters, or the characters that delimit or quote addresses in
 * headers (`<>()[]\,;:"`), and exactly one `@`. Quoted local parts and IP-literal domains are not
 * accepted. Anything that could end a header line (CR, LF) is whitespace and so excluded (08 T14).
 */
const LOCAL = String.raw`[^\s\p{Cc}@<>()[\]\\,;:"]{1,64}`;
const LABEL = String.raw`[^\s\p{Cc}@<>()[\]\\,;:".]+`;
const ADDRESS = new RegExp(String.raw`^${LOCAL}@${LABEL}(?:\.${LABEL})+$`, "u");

/**
 * Normalises and validates an address typed by a person: trim, Unicode NFC, lower case, then the
 * shape and length checks. No provider-specific canonicalisation: dots and `+tags` stay as typed
 * (04). Returns `null` for anything that isn't a plausible address.
 */
export function normaliseAddress(input: string): NormalisedEmail | null {
  const value = input.trim().normalize("NFC").toLowerCase();
  if (value.length > MAX_EMAIL_LENGTH || !ADDRESS.test(value)) return null;
  return value as NormalisedEmail;
}
