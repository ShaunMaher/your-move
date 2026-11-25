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
 * with no whitespace, control or format characters (bidi overrides, zero-width), or the characters that delimit or quote addresses in
 * headers (`<>()[]\,;:"`), and exactly one `@`. Quoted local parts and IP-literal domains are not
 * accepted. Anything that could end a header line (CR, LF) is whitespace and so excluded (08 T14).
 */
const LOCAL = String.raw`[^\s\p{Cc}\p{Cf}@<>()[\]\\,;:"]{1,64}`;
const LABEL = String.raw`[^\s\p{Cc}\p{Cf}@<>()[\]\\,;:".]+`;
const ADDRESS = new RegExp(String.raw`^${LOCAL}@${LABEL}(?:\.${LABEL})+$`, "u");

/** A delivery-safe domain: ASCII labels of letters, digits and inner hyphens, at least two. */
export const ASCII_DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

/**
 * The ASCII form of `domain`, or `null` when it can't be one that means the same thing. Any ASCII
 * character outside letters, digits, `.` and `-` is refused, and so is a domain that NFKC would
 * rewrite: a URL parser maps such characters to ASCII ones (`#`, `/`, `%`), which would send mail
 * somewhere other than the stored address says. Only a plain internationalised domain is
 * converted (punycode), with the same number of labels.
 */
function asciiDomain(domain: string): string | null {
  if (/\p{ASCII}/u.test(domain.replaceAll(/[A-Za-z0-9.-]/gu, ""))) return null;
  if (domain.normalize("NFKC") !== domain) return null;
  if (!/[^\p{ASCII}]/u.test(domain)) return ASCII_DOMAIN.test(domain) ? domain : null;
  let converted: string;
  try {
    converted = new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
  const labels = (value: string): number => value.split(".").length;
  return ASCII_DOMAIN.test(converted) && labels(converted) === labels(domain) ? converted : null;
}

/**
 * Normalises and validates an address typed by a person: trim, Unicode NFC, lower case, then the
 * shape and length checks. No provider-specific canonicalisation: dots and `+tags` stay as typed
 * (04). The domain is stored in ASCII (an internationalised one as punycode), so the stored
 * address is exactly the one mail is delivered to (09 §2, 08 T14). Returns `null` for anything
 * that isn't a plausible address.
 */
export function normaliseAddress(input: string): NormalisedEmail | null {
  const value = input.trim().normalize("NFC").toLowerCase();
  if (value.length > MAX_EMAIL_LENGTH || !ADDRESS.test(value)) return null;
  const at = value.lastIndexOf("@");
  const domain = asciiDomain(value.slice(at + 1));
  if (domain === null) return null;
  const address = `${value.slice(0, at)}@${domain}`;
  return address.length > MAX_EMAIL_LENGTH ? null : (address as NormalisedEmail);
}
