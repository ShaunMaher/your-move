/**
 * Where a signed-out visit was headed (07 §1): remembered across the sign-in screens, then used
 * once to land the person where they meant to go. Only same-origin app paths are accepted, so
 * the value can never send anyone to another site, and the paths the server handles (its API,
 * its pages) are never one of them.
 */
const KEY = "ym.return-path";
const MAX_LENGTH = 200;

/**
 * Never a destination: the sign-in screens themselves, and the privacy page, which anyone may read
 * on the way without it taking the place of where they were headed (07 §1).
 */
const AUTH_PATHS: ReadonlySet<string> = new Set(["/signin", "/welcome", "/privacy"]);

let inMemory: string | null = null;

/** Whether a path (query and fragment aside) is one the server handles, not a screen of the app. */
function isServerPath(value: string): boolean {
  const pathname = value.split(/[?#]/u)[0] ?? value;
  return __SERVER_PATHS__.some((pattern) =>
    pattern.endsWith("/*")
      ? pathname === pattern.slice(0, -2) || pathname.startsWith(pattern.slice(0, -1))
      : pathname === pattern,
  );
}

/** An app path on this origin: one slash first, no `//`, backslash or control characters. */
export function isAppPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return false;
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000- \u007f]/u.test(value)) {
    return false;
  }
  if (!isDestination(value) || isServerPath(value)) return false;
  // Nothing the URL parser would rewrite: no `%` escapes, no `.` or `..` segments.
  const pathname = value.split(/[?#]/u)[0] ?? value;
  if (pathname.includes("%")) return false;
  try {
    return new URL(value, "http://x").pathname === pathname;
  } catch {
    return false;
  }
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

/** Whether the screen shown is a real destination, which the remembered path was for. */
export function isDestination(path: string): boolean {
  return !AUTH_PATHS.has(path);
}

export function clearReturnPath(): void {
  inMemory = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing stored that could be removed.
  }
}
