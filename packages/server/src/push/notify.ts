/**
 * Which pushes a game transition sends, and sending them (docs/spec/03-architecture.md §7, 02 §8,
 * 08 T18; alpha A8): "your turn" to every seat whose clock the transition started, and "game over"
 * to every seated player when a game that reached `active` ends — never to the person whose
 * request made the transition, who is looking at it. A lobby event sends nothing: the alpha has
 * neither auto-join nor invitation pushes, and lobby endings never push (02 §4).
 *
 * The text is built only from the public `describe` text and display names (T18): no state, no
 * options, no scores beyond what `describe` says, no addresses. Runs in the background after the
 * response; nothing here can fail the transition.
 */
import { formatText, type Text } from "@your-move/sdk";

import type { GamePlayerRecord, GameWriteSet, LoadedGame, UserRecord } from "../db/repositories.js";
import { namesBySeat, playerName, seatedRows } from "../games/names.js";
import type { Platform } from "../platform.js";
import type { PushMessage } from "./sender.js";

/** Subscriptions kept per user (04, 08 T12). */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/**
 * Pushes one transition sends at most: eight seats with ten devices each would be 70 outbound
 * requests, beyond the 50 subrequests a Workers invocation may make (09 §3).
 */
const MAX_PUSHES_PER_TRANSITION = 40;
/** Lock screens show a line or two; longer text is cut. */
const MAX_BODY_LENGTH = 240;

/** One recipient of a transition's pushes. */
export interface TransitionPush {
  readonly userId: string;
  readonly seat: number;
  readonly kind: "turn" | "ended";
}

/** The transition as the pushes see it. */
export interface PushedTransition {
  /** The game and its players as they were before the transition. */
  readonly before: LoadedGame;
  readonly writes: GameWriteSet;
  /** The user whose request made the transition. */
  readonly actorUserId: string;
  /** The transition's public `describe` text; null for one the module wasn't called for. */
  readonly describe: Text | null;
}

/** The players' rows after the transition's row updates. */
function playersAfter(transition: PushedTransition): GamePlayerRecord[] {
  const updates = new Map(
    (transition.writes.updatePlayers ?? []).map((update) => [update.id, update.set]),
  );
  return transition.before.players.map((row) => ({ ...row, ...updates.get(row.id) }));
}

function ends(transition: PushedTransition): boolean {
  const status = transition.writes.game.status;
  return (
    transition.before.game.status === "active" && (status === "finished" || status === "declined")
  );
}

/**
 * Who the transition notifies, and of what: every seated player but the actor when an `active`
 * game ends; otherwise each seat, other than the actor's, whose clock the transition started
 * (`to_act_since` set: it entered `toAct`, including at the start, 02 §2.3).
 */
export function transitionPushes(transition: PushedTransition): TransitionPush[] {
  const ended = ends(transition);
  const started = new Set(
    (transition.writes.updatePlayers ?? [])
      .filter((update) => typeof update.set.toActSince === "number")
      .map((update) => update.id),
  );
  return seatedRows(playersAfter(transition)).flatMap((row): TransitionPush[] => {
    if (row.userId === null || row.seat === null || row.userId === transition.actorUserId) {
      return [];
    }
    if (ended) return [{ userId: row.userId, seat: row.seat, kind: "ended" }];
    if (started.has(row.id) && row.state === "playing" && row.toAct === 1) {
      return [{ userId: row.userId, seat: row.seat, kind: "turn" }];
    }
    return [];
  });
}

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** A sentence: the text with a full stop unless it already ends in one. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function cut(text: string): string {
  return text.length <= MAX_BODY_LENGTH ? text : `${text.slice(0, MAX_BODY_LENGTH - 1)}…`;
}

/**
 * The notification for one recipient (03 §7, T18): the `describe` text with names filled in
 * ("You" for the recipient) and "Your turn." or "The game is over."; a start, which has no
 * `describe` text, names the other players; a framework-only ending names whoever declined.
 */
export function pushMessage(
  transition: PushedTransition,
  recipient: TransitionPush,
  users: ReadonlyMap<string, Pick<UserRecord, "displayName">>,
  appName: string,
): PushMessage {
  const seated = seatedRows(playersAfter(transition));
  const names = namesBySeat(seated, users, recipient.seat);
  const lead =
    transition.describe === null ? null : sentence(formatText(transition.describe, names));
  let body: string;
  if (recipient.kind === "turn") {
    const others = seated
      .filter((row) => row.seat !== recipient.seat)
      .map((row) => playerName(row, users));
    body = `${lead ?? `Your game with ${list(others)} has started.`} Your turn.`;
  } else if (lead !== null) {
    body = `${lead} The game is over.`;
  } else {
    const actor = seated.find((row) => row.userId === transition.actorUserId);
    body =
      actor === undefined
        ? "The game is over."
        : `${playerName(actor, users)} declined the game, so it's over.`;
  }
  const gameId = transition.before.game.id;
  return {
    title: appName,
    body: cut(body),
    url: `/g/${encodeURIComponent(gameId)}`,
    tag: `game-${gameId}`,
  };
}

/**
 * Sends the transition's pushes to every subscription of each recipient. A subscription the push
 * service no longer knows (404, 410) is deleted; a failure is logged by status or error class
 * only, never the endpoint (a capability URL) or the text.
 */
export async function sendTransitionPushes(
  platform: Platform,
  transition: PushedTransition,
): Promise<void> {
  const { repos, log, push } = platform;
  if (!push.enabled) return;
  const recipients = transitionPushes(transition);
  if (recipients.length === 0) return;
  const subscriptions = await repos.pushSubscriptions.forUsers([
    ...new Set(recipients.map((recipient) => recipient.userId)),
  ]);
  if (subscriptions.length === 0) return;
  const seatedIds = seatedRows(playersAfter(transition)).flatMap((row) =>
    row.userId === null ? [] : [row.userId],
  );
  const users = new Map((await repos.users.findByIds(seatedIds)).map((user) => [user.id, user]));
  const messages = new Map(
    recipients.map((recipient) => [
      recipient.userId,
      pushMessage(transition, recipient, users, platform.config.appName),
    ]),
  );
  if (subscriptions.length > MAX_PUSHES_PER_TRANSITION) {
    log.warn("push: more subscriptions than one transition sends to", {
      subscriptions: subscriptions.length,
      sent: MAX_PUSHES_PER_TRANSITION,
    });
  }
  const delivered: string[] = [];
  const gone: string[] = [];
  await Promise.all(
    subscriptions.slice(0, MAX_PUSHES_PER_TRANSITION).map(async (subscription) => {
      const message = messages.get(subscription.userId);
      if (message === undefined) return;
      const outcome = await push.send(subscription, message);
      if (outcome.kind === "delivered") delivered.push(subscription.id);
      else if (outcome.kind === "gone") gone.push(subscription.id);
      else {
        log.warn("push not delivered", {
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          ...(outcome.errorClass === undefined ? {} : { errorClass: outcome.errorClass }),
        });
      }
    }),
  );
  // One statement each, however many devices: a Worker invocation's D1 queries are limited.
  await repos.pushSubscriptions.delivered(delivered, platform.now().getTime());
  await repos.pushSubscriptions.delete(gone);
  if (gone.length > 0) {
    log.info("push subscriptions removed: gone at their push service", { count: gone.length });
  }
}
