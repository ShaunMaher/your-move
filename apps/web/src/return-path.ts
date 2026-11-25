/**
 * Where a signed-out visit was headed (07 §1): remembered across the sign-in screens, then used
 * once to land the person where they meant to go. Only same-origin app paths are accepted, so
 * the value can never send anyone to another site.
 */
const KEY = "ym.return-path";
const MAX_LENGTH = 200;

/** Never a destination: the sign-in screens themselves. */
const AUTH_PATHS: ReadonlySet<string> = new Set(["/signin", "/welcome"]);

let inMemory: string | null = null;

/** An absolute path on this origin: one slash first, no `//`, backslash or control characters. */
export function isAppPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000- \u007f]/u.test(value)) {
    return false;
  }
  return !AUTH_PATHS.has(value);
}

export function rememberReturnPath(path: string): void {
  if (!isAppPath(path)) return;
  inMemory = path;
  try {
    window.sessionStorage.setItem(KEY, path);
  } catch {
    // Storage unavailable: the in-memory copy serves until the page is reloaded.
  }
}

/** The remembered path, validated again on the way out; null when there is none. */
export function peekReturnPath(): string | null {
  let stored: string | null = inMemory;
  try {
    stored = window.sessionStorage.getItem(KEY) ?? stored;
  } catch {
    // Use the in-memory copy.
  }
  return isAppPath(stored) ? stored : null;
}

export function clearReturnPath(): void {
  inMemory = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored that could be removed.
  }
}
