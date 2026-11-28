/**
 * A join link made with a new game (05 `joinLinkUrl`), handed from the new-game flow to the lobby
 * that shows it once (07 §1.1 step 5). In memory only: the URL is never stored or put in the
 * address bar, and a reload simply doesn't show it again (the creator can make a new one).
 */
let pending: { readonly gameId: string; readonly url: string } | null = null;

export function handOffJoinLink(gameId: string, url: string): void {
  pending = { gameId, url };
}

/** The link handed off for this game, if any (a render may ask more than once). */
export function peekJoinLink(gameId: string): string | null {
  return pending?.gameId === gameId ? pending.url : null;
}

/** Forgets the link handed off for this game, once the lobby has taken it. */
export function forgetJoinLink(gameId: string): void {
  if (pending?.gameId === gameId) pending = null;
}
