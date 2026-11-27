/**
 * A join link's token on its way through the app (07 §1 `/join`, 06 §6.8, 08 T24). The link is
 * `/join#<token>`: the fragment never reaches a server, and the page takes it out of the address
 * bar and the history as soon as it loads (`history.replaceState` to plain `/join`). The token is
 * kept in `sessionStorage` in an entry of its own, which only a well-formed `/join#<token>` fills,
 * so a signed-out visitor still has it after signing in or onboarding, while the sign-in screens'
 * return path is plain `/join` and the token never comes back into the address bar. It is cleared
 * after a join, a `404`, and whenever the session ends in this tab.
 */
const KEY = "ym.join";
/** What the entry may hold: the path and fragment of a join link (07 §1), nothing else. */
const VALUE = /^\/join#([A-Za-z0-9_-]{22})$/u;
export const JOIN_PATH = "/join";

let inMemory: string | null = null;

function store(value: string | null): void {
  inMemory = value;
  try {
    if (value === null) window.sessionStorage.removeItem(KEY);
    else window.sessionStorage.setItem(KEY, value);
  } catch {
    // Storage unavailable: the in-memory copy serves until the page is reloaded.
  }
}

/**
 * Takes a join link's fragment out of the address bar (and so out of the history) and keeps it.
 * A fragment that isn't a token replaces any kept one with nothing: the page then says the link
 * doesn't work, never shows an older link instead. Does nothing on any other page.
 */
export function captureJoinFragment(): void {
  const { pathname, hash } = window.location;
  if (pathname !== JOIN_PATH || hash === "") return;
  window.history.replaceState(window.history.state, "", JOIN_PATH);
  const value = `${JOIN_PATH}${hash}`;
  store(VALUE.test(value) ? value : null);
}

/** The kept token, checked again on the way out; null when there is none. */
export function keptJoinToken(): string | null {
  let value = inMemory;
  try {
    value = window.sessionStorage.getItem(KEY) ?? value;
  } catch {
    // Use the in-memory copy.
  }
  return VALUE.exec(value ?? "")?.[1] ?? null;
}

export function clearJoinToken(): void {
  store(null);
}
