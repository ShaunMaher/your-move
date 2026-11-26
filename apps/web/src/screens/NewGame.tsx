/**
 * The new-game flow (07 §1.1): pick a game, set its options (the module's own form), choose the
 * players — people you've played, picked from the list, or anyone by email — check them, create.
 * The alpha's slice of the flow: no join link, AI seats, seat order or turn timeout (10, Alpha), so
 * the creator's choices are the game, the options, the seat count and the players. A game whose
 * seats are all people you've played starts at once and opens on the board; otherwise the lobby.
 */
import type { ApiClient } from "@your-move/api-client";
import type { GameClientModule } from "@your-move/sdk/client";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import { loadCatalog } from "../catalog.js";
import { type CatalogGame, createGame, listRecentPlayers, type RecentPlayer } from "../game-api.js";
import { GameIcon } from "../GameIcon.js";
import { loadGameClient } from "../games.js";
import { rememberPushOffered, shouldOfferPush } from "../push.js";
import { PushOffer } from "../PushOffer.js";
import { navigate, Link } from "../router.js";
import { looksLikeEmail } from "../text.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface NewGameProps {
  readonly api: ApiClient;
  readonly appName: string;
  /** The instance's VAPID public key, for the notifications offer after creating (03 §7). */
  readonly pushKey: string | undefined;
  readonly ownEmail: string;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
}

type Step = "game" | "options" | "players" | "review";

function playerRange(game: CatalogGame): string {
  const { min, max } = game.players;
  return min === max ? `${String(min)} players` : `${String(min)} to ${String(max)} players`;
}

const CREATE_PROBLEMS: Readonly<Record<string, string>> = {
  INVALID_OPTIONS: "Those options can't be used. Go back and check them.",
  INVALID_SEATS: "Those options don't work with this many players. Go back and check them.",
  INVALID_SEAT_COUNT: "That number of players isn't allowed for this game.",
  INVALID_INVITEES:
    "Check the players: each address must be valid and different, and each person you picked must still be in your list.",
  CANNOT_PLAY_SELF: "You can't invite yourself. Enter the other person's address.",
  TOO_MANY_GAMES: "You have too many games waiting or in progress. Finish or cancel one first.",
  RATE_LIMITED: "Too many attempts. Wait a little and try again.",
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
};

function createProblem(status: number, code: string): string {
  if (status === 0) return "You seem to be offline. Check your connection and try again.";
  return CREATE_PROBLEMS[code] ?? "Something went wrong. Please try again.";
}

export function NewGame({ api, appName, pushKey, ownEmail, onSessionLost }: NewGameProps) {
  const [games, setGames] = useState<readonly CatalogGame[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [step, setStep] = useState<Step>("game");
  const [chosen, setChosen] = useState<CatalogGame | null>(null);
  const [client, setClient] = useState<GameClientModule | null | "loading">("loading");
  const [options, setOptions] = useState<unknown>({});
  const [seats, setSeats] = useState(2);
  const [emails, setEmails] = useState<readonly string[]>([""]);
  /** People you've played (05 `/players/recent`); null until loaded, or if they couldn't be. */
  const [recent, setRecent] = useState<readonly RecentPlayer[] | null>(null);
  /** The past opponents picked, by user id, in the order picked: each fills a seat. */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** The created game's path, while the notifications offer is open. */
  const [offering, setOffering] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** The game whose client module is wanted now: a load for any other one is ignored when it ends. */
  const wanted = useRef<string | null>(null);
  useEffect(
    () => () => {
      wanted.current = null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void loadCatalog(api).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setGames(result.data.games);
        setLoadError(null);
      } else if (result.status === 401) onSessionLost();
      else {
        setLoadError(
          result.status === 0
            ? "You seem to be offline. Check your connection and try again."
            : "Couldn't load the games. Please try again.",
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt, onSessionLost]);

  // The people you've played, for the players step. Without them, typing addresses still works.
  useEffect(() => {
    let cancelled = false;
    void listRecentPlayers(api).then((result) => {
      if (cancelled) return;
      if (result.ok) setRecent(result.data.players);
      else if (result.status === 401) onSessionLost();
    });
    return () => {
      cancelled = true;
    };
  }, [api, onSessionLost]);

  // A step is a new screen for a screen reader: start reading at its heading.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function choose(game: CatalogGame) {
    setChosen(game);
    setOptions(game.defaults ?? {});
    const seatCount = game.players.min;
    setSeats(seatCount);
    setPicked([]);
    setEmails(Array.from({ length: seatCount - 1 }, () => ""));
    setProblem(null);
    setClient("loading");
    wanted.current = game.type;
    void loadGameClient(game.type).then((module) => {
      if (wanted.current === game.type) setClient(module);
    });
    setStep("options");
  }

  /** Keeps one address field for each seat that no picked past opponent fills. */
  function fitEmails(open: number) {
    setEmails((now) => Array.from({ length: Math.max(0, open) }, (_, index) => now[index] ?? ""));
  }

  function setSeatCount(next: number) {
    setSeats(next);
    const kept = picked.slice(0, next - 1);
    setPicked(kept);
    fitEmails(next - 1 - kept.length);
  }

  /** Picking someone fills a seat; unpicking frees it for an address. */
  function togglePicked(userId: string) {
    const next = picked.includes(userId)
      ? picked.filter((id) => id !== userId)
      : [...picked, userId].slice(0, seats - 1);
    setPicked(next);
    fitEmails(seats - 1 - next.length);
    setProblem(null);
  }

  const nameOf = (userId: string): string =>
    recent?.find((player) => player.userId === userId)?.displayName ?? "";

  function checkPlayers(event: SyntheticEvent) {
    event.preventDefault();
    const typed = emails.map((email) => email.trim().toLowerCase());
    if (typed.some((email) => !looksLikeEmail(email))) {
      setProblem("Enter an email address for each player.");
      return;
    }
    if (new Set(typed).size !== typed.length) {
      setProblem("Each address must be different.");
      return;
    }
    if (typed.includes(ownEmail.toLowerCase())) {
      setProblem("That's your own address. Enter the other person's.");
      return;
    }
    setEmails(typed);
    setProblem(null);
    setStep("review");
  }

  async function create() {
    if (chosen === null || pending) return;
    setPending(true);
    setProblem(null);
    const result = await createGame(api, {
      gameType: chosen.type,
      options,
      seats,
      invitees: [...picked.map((userId) => ({ userId })), ...emails.map((email) => ({ email }))],
    });
    if (result.ok) {
      const path = `/g/${encodeURIComponent(result.data.game.id)}`;
      if (pushKey !== undefined && (await shouldOfferPush(pushKey))) {
        rememberPushOffered();
        setOffering(path);
      } else navigate(path);
      return;
    }
    setPending(false);
    if (result.status === 401) onSessionLost();
    else setProblem(createProblem(result.status, result.code));
  }

  const back = (to: Step) => () => {
    setProblem(null);
    setStep(to);
  };
  const Options = client === "loading" || client === null ? null : client.OptionsForm;

  return (
    <Page appName={appName} nav={<Link to="/">Home</Link>}>
      <h1 tabIndex={-1} ref={heading}>
        New game
      </h1>

      {step === "game" ? (
        <section className="stack" aria-labelledby="pick-heading">
          <h2 id="pick-heading">Choose a game</h2>
          {games === null ? (
            <div className="stack">
              <p role="status">{loadError ?? "Loading…"}</p>
              {loadError === null ? null : (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              )}
            </div>
          ) : games.length === 0 ? (
            <p>No games are installed on this server.</p>
          ) : (
            <ul className="plain">
              {games.map((game) => (
                <li key={game.type}>
                  <button
                    type="button"
                    className="game-row card"
                    onClick={() => {
                      choose(game);
                    }}
                  >
                    <GameIcon icon={game.icon} />
                    <span className="grow">
                      <span className="row-title">{game.name}</span>
                      <span className="hint">{game.description}</span>
                      <span className="hint">{playerRange(game)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {step === "options" && chosen !== null ? (
        <section className="stack" aria-labelledby="options-heading">
          <h2 id="options-heading">{chosen.name}: options</h2>
          {client === "loading" ? <p role="status">Loading…</p> : null}
          {client === null ? (
            <p role="alert" className="problem">
              This game can&apos;t be shown by this version of the app. Reload the page to update.
            </p>
          ) : null}
          {Options === null ? null : (
            <Options catalog={chosen.catalog} value={options} onChange={setOptions} />
          )}
          <div className="row">
            <button type="button" className="button secondary" onClick={back("game")}>
              Back
            </button>
            <button
              type="button"
              className="button"
              disabled={Options === null}
              onClick={() => {
                setStep("players");
              }}
            >
              Next
            </button>
          </div>
        </section>
      ) : null}

      {step === "players" && chosen !== null ? (
        <form
          className="stack"
          onSubmit={checkPlayers}
          noValidate
          aria-labelledby="players-heading"
        >
          <h2 id="players-heading">Who are you playing?</h2>
          {chosen.players.min < chosen.players.max ? (
            <div className="field">
              <label htmlFor="seat-count">Number of players</label>
              <select
                id="seat-count"
                value={seats}
                onChange={(event) => {
                  setSeatCount(Number(event.target.value));
                }}
              >
                {Array.from(
                  { length: chosen.players.max - chosen.players.min + 1 },
                  (_, index) => chosen.players.min + index,
                ).map((count) => (
                  <option key={count} value={count}>
                    {String(count)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {recent !== null && recent.length > 0 ? (
            <fieldset className="card stack">
              <legend>
                <h3>People you&apos;ve played</h3>
              </legend>
              {recent.map((player) => {
                const chosen = picked.includes(player.userId);
                return (
                  <label key={player.userId} className="check">
                    <input
                      type="checkbox"
                      checked={chosen}
                      disabled={!chosen && picked.length >= seats - 1}
                      aria-describedby="picked-note"
                      onChange={() => {
                        togglePicked(player.userId);
                      }}
                    />
                    {player.displayName}
                  </label>
                );
              })}
              <p id="picked-note" className="hint">
                Someone you pick joins the game at once, with no invitation to accept.
              </p>
            </fieldset>
          ) : null}
          {emails.map((email, index) => (
            <div className="field" key={index}>
              <label htmlFor={`player-${String(index)}`}>
                {seats === 2
                  ? "Their email address"
                  : `Player ${String(picked.length + index + 2)}'s email address`}
              </label>
              <input
                id={`player-${String(index)}`}
                type="email"
                inputMode="email"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                aria-describedby="players-note players-problem"
                onChange={(event) => {
                  setEmails((now) =>
                    now.map((was, at) => (at === index ? event.target.value : was)),
                  );
                }}
              />
            </div>
          ))}
          {emails.length > 0 ? (
            <p id="players-note" className="hint">
              {recent !== null && recent.length > 0 ? "Or type an address. " : ""}
              They must have signed in to {appName} at least once first, with this address. We
              can&apos;t invite someone who has never signed in.
            </p>
          ) : null}
          <Problem id="players-problem" message={problem} />
          <div className="row">
            <button type="button" className="button secondary" onClick={back("options")}>
              Back
            </button>
            <button type="submit" className="button">
              Review
            </button>
          </div>
        </form>
      ) : null}

      {step === "review" && chosen !== null ? (
        <section className="stack" aria-labelledby="review-heading">
          <h2 id="review-heading">Ready to create?</h2>
          <p>
            A {chosen.name} game for {String(seats)} players.
            {emails.length === 0
              ? " It starts as soon as you create it."
              : ` Check the ${emails.length === 1 ? "address" : "addresses"}: we never say whether an address has an account, so a typo just means an invitation nobody receives.`}
          </p>
          <ul className="plain">
            {picked.map((userId) => (
              <li key={userId} className="card">
                Playing with <strong>{nameOf(userId)}</strong>
              </li>
            ))}
            {emails.map((email) => (
              <li key={email} className="card">
                Check the address: <strong>{email}</strong>
              </li>
            ))}
          </ul>
          <Problem id="review-problem" message={problem} />
          <div className="row">
            <button type="button" className="button secondary" onClick={back("players")}>
              Back
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void create()}
            >
              {pending ? "Creating…" : "Create game"}
            </button>
          </div>
        </section>
      ) : null}
      {offering !== null && pushKey !== undefined ? (
        <PushOffer
          api={api}
          appName={appName}
          pushKey={pushKey}
          onDone={() => {
            navigate(offering);
          }}
        />
      ) : null}
    </Page>
  );
}
