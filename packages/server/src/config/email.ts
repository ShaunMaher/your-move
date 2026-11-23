/** Normalises an email address for storage and comparison: trim, Unicode NFC, lower case (04). */
export function normaliseEmail(address: string): string {
  return address.trim().normalize("NFC").toLowerCase();
}

const ADDRESS = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+$/u;

/** Whether `address` looks like a single plain email address (no display name, no list). */
export function isEmailAddress(address: string): boolean {
  return ADDRESS.test(address);
}

/**
 * Parses an `EMAIL_FROM` value: `addr@example.org`, `Name <addr@example.org>` or
 * `"Name" <addr@example.org>`. Returns the address part, or `null` if the value is malformed or
 * contains a line break (header injection, 08 T14).
 */
export function parseMailbox(value: string): { name: string | null; address: string } | null {
  if (/[\r\n]/u.test(value)) return null;
  const trimmed = value.trim();
  const angle = /^(?:"([^"]*)"|([^<>"]*?))\s*<([^<>]+)>$/u.exec(trimmed);
  if (angle) {
    const address = angle[3] ?? "";
    if (!isEmailAddress(address)) return null;
    const name = (angle[1] ?? angle[2] ?? "").trim();
    return { name: name === "" ? null : name, address };
  }
  return isEmailAddress(trimmed) ? { name: null, address: trimmed } : null;
}
