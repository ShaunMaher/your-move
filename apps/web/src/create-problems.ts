/**
 * What creating a game can be refused with, as the screens say it: the new-game flow's texts
 * (07 §1.1), and the rematch button's (07 §1), which shares the creation path's refusals (05
 * `POST /api/v1/games/:id/rematch`) and adds its own.
 */

const OFFLINE = "You seem to be offline. Check your connection and try again.";
const UNKNOWN = "Something went wrong. Please try again.";

/** The refusals a new game and a rematch share: limits and the account (05 Created). */
const SHARED: Readonly<Record<string, string>> = {
  INVALID_SEAT_COUNT: "That number of players isn't allowed for this game.",
  TOO_MANY_GAMES: "You have too many games waiting or in progress. Finish or cancel one first.",
  RATE_LIMITED: "Too many attempts. Wait a little and try again.",
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
};

const CREATE_PROBLEMS: Readonly<Record<string, string>> = {
  ...SHARED,
  INVALID_OPTIONS: "Those options can't be used. Go back and check them.",
  INVALID_SEATS: "Those options don't work with this many players. Go back and check them.",
  INVALID_INVITEES:
    "Check the players: each address must be valid and different, and each person you picked must still be in your list.",
  CANNOT_PLAY_SELF: "You can't invite yourself. Enter the other person's address.",
};

/**
 * A rematch has no form to go back to: where the new-game flow says "go back and check", these say
 * what to do instead.
 */
const REMATCH_PROBLEMS: Readonly<Record<string, string>> = {
  ...SHARED,
  INVALID_OPTIONS: "This game's options aren't available to you. Start a new game instead.",
  INVALID_SEATS: "This game's options don't work any more. Start a new game instead.",
  INVALID_INVITEES:
    "Someone from this game can't be added any more. Start a new game with the people you can play.",
  UNKNOWN_GAME: "This game isn't available any more.",
  REMATCH_UNAVAILABLE: "There's no one left from this game to play with. Start a new game instead.",
  NOT_FOUND: "You're no longer in this rematch.",
  WRONG_STATUS: "The rematch has already ended.",
  STALE_GAME: "The rematch changed while you were joining it. Try again.",
  GAME_UNAVAILABLE: "This game is no longer available.",
};

function problem(known: Readonly<Record<string, string>>, status: number, code: string): string {
  if (status === 0) return OFFLINE;
  return known[code] ?? UNKNOWN;
}

/** Why a new game wasn't created (07 §1.1). */
export function createProblem(status: number, code: string): string {
  return problem(CREATE_PROBLEMS, status, code);
}

/** Why the rematch button didn't open the rematch (07 §1). */
export function rematchProblem(status: number, code: string): string {
  return problem(REMATCH_PROBLEMS, status, code);
}
