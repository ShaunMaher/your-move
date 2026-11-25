/**
 * The one MIME builder (docs/spec/09-operations.md §2, 08 T14): turns an {@link EmailMessage}
 * into a raw RFC 5322 message for providers that take raw MIME (`gmail` now, SMTP later). Web
 * standards only, so it runs on both runtimes.
 *
 * - Every header value is checked for control characters (CR, LF, NUL, ...), and anything that
 *   isn't printable ASCII is RFC 2047 encoded, so no input can end its header or start another.
 * - Display names are quoted strings (backslash and quote escaped) or encoded words.
 * - Addresses must be plain ASCII `addr-spec`s, never converted here: a non-ASCII domain or local
 *   part is refused rather than sent somewhere other than the stored address.
 * - The body is `multipart/alternative`: plain text, then HTML, both quoted-printable UTF-8.
 */
import { isSendableAddress } from "../accounts/email.js";
import { toBase64 } from "../base64.js";
import { EmailHeaderError } from "./sender.js";

interface MimeMailbox {
  /** The display name, or null for a bare address. */
  readonly name: string | null;
  readonly address: string;
}

export interface MimeInput {
  readonly from: MimeMailbox;
  /** The recipient's address. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly date: Date;
  /** `local@domain`, without angle brackets; unique per message. */
  readonly messageId: string;
  /** An http(s) unsubscribe URL: adds `List-Unsubscribe` and the RFC 8058 one-click header. */
  readonly listUnsubscribe?: string;
}

/**
 * The multipart boundary. A body can't contain it: quoted-printable writes every `=` as `=3D`, so
 * no body line can read `--=_ym_...`.
 */
const BOUNDARY = "=_ym_alt_boundary";
const CRLF = "\r\n";
const PRINTABLE_ASCII = /^[ -~]*$/u;
/** Bytes per encoded word: 36 bytes become 48 base64 characters, 60 with the word's wrapper. */
const WORD_BYTES = 36;
const encoder = new TextEncoder();

function refuseControls(value: string, what: string): void {
  if (/\p{Cc}/u.test(value)) throw new EmailHeaderError(`${what} contains a control character`);
}

/** RFC 2047 `B` encoded words for `value`, never splitting a character, joined by folding. */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = (): void => {
    if (chunk.length > 0) words.push(`=?UTF-8?B?${toBase64(Uint8Array.from(chunk))}?=`);
    chunk = [];
  };
  for (const character of value) {
    const bytes = encoder.encode(character);
    if (chunk.length + bytes.length > WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  flush();
  return words.join(`${CRLF} `);
}

/** An unstructured header value such as a subject. */
function encodeText(value: string, what: string): string {
  refuseControls(value, what);
  if (PRINTABLE_ASCII.test(value) && value.length <= 60 && !value.includes("=?")) return value;
  return encodedWords(value);
}

/** The display name of a mailbox, as a quoted string or encoded words. */
function encodePhrase(name: string): string {
  refuseControls(name, "display name");
  if (PRINTABLE_ASCII.test(name) && name.length <= 40) {
    return `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return encodedWords(name);
}

/**
 * A checked ASCII `addr-spec`. Nothing is converted: an address whose domain isn't already ASCII is
 * refused, because the stored address must be the one delivered to (`normaliseAddress` stores the
 * punycode form).
 */
function encodeAddress(address: string, what: string): string {
  refuseControls(address, what);
  if (!isSendableAddress(address)) {
    throw new EmailHeaderError(`${what} is not a valid ASCII address`);
  }
  return address;
}

function mailbox({ name, address }: MimeMailbox, what: string): string {
  const spec = encodeAddress(address, what);
  if (name === null || name === "") return spec;
  const phrase = encodePhrase(name);
  // After encoded words the address goes on its own folded line, to stay within 78 columns.
  return `${phrase}${phrase.startsWith('"') ? " " : `${CRLF} `}<${spec}>`;
}

/** The longest unsubscribe URL accepted: the header line stays well inside RFC 5322's 998. */
const MAX_UNSUBSCRIBE_URL = 900;

/**
 * A checked `List-Unsubscribe` value (RFC 2369): one http(s) URL of printable ASCII with no
 * spaces or angle brackets, so it can't end its brackets or its header.
 */
function unsubscribeHeader(url: string): string {
  refuseControls(url, "unsubscribe URL");
  if (url.length > MAX_UNSUBSCRIBE_URL || !/^[!-~]+$/u.test(url) || /[<>]/u.test(url)) {
    throw new EmailHeaderError("unsubscribe URL is not valid");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EmailHeaderError("unsubscribe URL is not valid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EmailHeaderError("unsubscribe URL is not http(s)");
  }
  return `<${url}>`;
}

/** RFC 5322 `date-time` in UTC, e.g. `Thu, 01 Jan 1970 00:00:00 +0000`. */
function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new EmailHeaderError("date is not valid");
  return date.toUTCString().replace(/ GMT$/u, " +0000");
}

/** Quoted-printable (RFC 2045 §6.7) of `text`'s UTF-8 bytes, with CRLF line ends. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/gu, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const bytes = encoder.encode(line);
    let current = "";
    bytes.forEach((byte, index) => {
      const last = index === bytes.length - 1;
      const literal =
        (byte >= 33 && byte <= 126 && byte !== 61) || ((byte === 32 || byte === 9) && !last);
      const token = literal
        ? String.fromCharCode(byte)
        : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      if (current.length + token.length > 75) {
        out.push(`${current}=`);
        current = "";
      }
      current += token;
    });
    out.push(current);
  }
  return out.join(CRLF);
}

function part(type: string, body: string): string[] {
  return [
    `--${BOUNDARY}`,
    `Content-Type: ${type}; charset=UTF-8`,
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(body),
  ];
}

/** Builds the raw message. Throws {@link EmailHeaderError} for anything unsafe in a header. */
export function buildMime(input: MimeInput): string {
  refuseControls(input.messageId, "message id");
  if (!/^[A-Za-z0-9._~+-]+@[A-Za-z0-9.-]+$/u.test(input.messageId)) {
    throw new EmailHeaderError("message id is not valid");
  }
  const headers: string[] = [
    `From: ${mailbox(input.from, "sender")}`,
    `To: ${mailbox({ name: null, address: input.to }, "recipient")}`,
    `Subject: ${encodeText(input.subject, "subject")}`,
    `Date: ${formatDate(input.date)}`,
    `Message-ID: <${input.messageId}>`,
    "MIME-Version: 1.0",
  ];
  if (input.listUnsubscribe !== undefined) {
    headers.push(
      `List-Unsubscribe: ${unsubscribeHeader(input.listUnsubscribe)}`,
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    );
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${BOUNDARY}"`);
  const body = [
    ...part("text/plain", input.text),
    ...part("text/html", input.html),
    `--${BOUNDARY}--`,
    "",
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body.join(CRLF)}`;
}
