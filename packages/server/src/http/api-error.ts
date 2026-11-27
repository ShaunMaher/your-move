/**
 * A refused request with a framework error code (05 §Errors) or a game module's own code, thrown by
 * a handler and answered by the app's error handler with `{ error: { code, message, detail? } }`.
 * Refusals are the client's to act on, never server faults: they are logged below error level.
 */
import { ERROR_STATUS, type ErrorCode } from "@your-move/shared";

/** Display messages of the codes handlers refuse with; clients branch on the code (05). */
const MESSAGES: Partial<Record<ErrorCode, string>> = {
  BAD_REQUEST: "The request was rejected.",
  INVALID_ACTION: "That isn't a valid move for this game.",
  INVALID_OPTIONS: "Those game options can't be used.",
  INVALID_SEAT_COUNT: "That number of players isn't possible for this game.",
  INVALID_TIMEOUT: "The turn timeout must be a whole number of days from 1 to 30.",
  INVALID_INVITEES: "Check the players you added.",
  CANNOT_PLAY_SELF: "You can't invite yourself.",
  UNKNOWN_GAME: "That game isn't available.",
  NOT_ALLOWED: "You can't do that in this game.",
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
  NOT_FOUND: "Not found.",
  STALE_GAME: "The game has changed. Refresh and try again.",
  GAME_NOT_ACTIVE: "This game isn't in progress.",
  GAME_UNAVAILABLE: "This game is no longer available.",
  NOT_YOUR_TURN: "It isn't your turn.",
  WRONG_STATUS: "That can't be done at this point of the game.",
  NOT_ENOUGH_PLAYERS: "Not enough players have joined yet.",
  INVALID_SEATS: "This game can't be played with that many players.",
  ALREADY_ACTED: "You've already played in this game.",
  TOO_MANY_GAMES: "You have too many games in progress.",
  REMATCH_UNAVAILABLE: "There's no one left from this game to play with.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
};

/** The message of a game module's own error code (05 §Errors, module errors). */
const MODULE_MESSAGE = "That move isn't allowed.";

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  private readonly display: string;

  private constructor(code: string, status: number, detail: unknown, display: string) {
    super(code);
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.display = display;
  }

  /** A framework refusal (05 §Errors). */
  static of(code: ErrorCode, detail?: unknown): ApiError {
    return new ApiError(code, ERROR_STATUS[code], detail, MESSAGES[code] ?? code);
  }

  /** A game module's `validate` or `preview` error: `400` with its code and detail as-is. */
  static module(code: string, detail: unknown): ApiError {
    return new ApiError(code, 400, detail, MODULE_MESSAGE);
  }

  /** The response body (05 §Conventions). */
  body(): { error: { code: string; message: string; detail?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.display,
        ...(this.detail === undefined ? {} : { detail: this.detail }),
      },
    };
  }
}
