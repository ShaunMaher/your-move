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
const ASCII_DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u;

/** An ASCII dot-atom local part (RFC 5322): no leading, trailing or consecutive dots. */
const ASCII_LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;

/**
 * Whether `address` is one the mail builder can send as it stands: an ASCII dot-atom local part of
 * at most 64 characters, an ASCII domain of letters, digits and inner hyphens with labels of at
 * most 63 characters, at most 253 in all, and a top-level label that isn't all digits (which would
 * read as an IP address). The one rule shared by {@link normaliseAddress}, the MIME builder and the
 * `EMAIL_FROM` check, so what is accepted can never be wider than what can be sent.
 */
export function isSendableAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 1 || address.length > MAX_EMAIL_LENGTH) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !ASCII_LOCAL_PART.test(local)) return false;
  if (domain.length > 253 || !ASCII_DOMAIN.test(domain)) return false;
  const labels = domain.split(".");
  return labels.every((label) => label.length <= 63) && !/^\d+$/u.test(labels.at(-1) ?? "");
}

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
  return isSendableAddress(address) ? (address as NormalisedEmail) : null;
}
