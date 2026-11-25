/**
 * The new-game flow (07 §1.1): pick a game, set its options (the module's own form), choose the
 * players by email, check the addresses, create. The alpha's slice of the flow: no past-opponent
 * picker, join link, AI seats, seat order or turn timeout (10, Alpha), so the creator's choices are
 * the game, the options, the seat count and the addresses.
 */
import type { ApiClient } from "@your-move/api-client";
import type { GameClientModule } from "@your-move/sdk/client";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import { loadCatalog } from "../catalog.js";
import { type CatalogGame, createGame } from "../game-api.js";
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
  INVALID_INVITEES: "Check the email addresses: each must be different and valid.",
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

  // A step is a new screen for a screen reader: start reading at its heading.
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  function choose(game: CatalogGame) {
    setChosen(game);
    setOptions(game.defaults ?? {});
    const seatCount = game.players.min;
    setSeats(seatCount);
    setEmails(Array.from({ length: seatCount - 1 }, () => ""));
    setProblem(null);
    setClient("loading");
    wanted.current = game.type;
    void loadGameClient(game.type).then((module) => {
      if (wanted.current === game.type) setClient(module);
    });
    setStep("options");
  }

  function setSeatCount(next: number) {
    setSeats(next);
    setEmails((now) => Array.from({ length: next - 1 }, (_, index) => now[index] ?? ""));
  }

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
      invitees: emails.map((email) => ({ email })),
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
          {emails.map((email, index) => (
            <div className="field" key={index}>
              <label htmlFor={`player-${String(index)}`}>
                {emails.length === 1
                  ? "Their email address"
                  : `Player ${String(index + 2)}'s email address`}
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
          <p id="players-note" className="hint">
            They must have signed in to {appName} at least once first, with this address. We
            can&apos;t invite someone who has never signed in.
          </p>
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
            A {chosen.name} game for {String(seats)} players. Check the{" "}
            {emails.length === 1 ? "address" : "addresses"}: we never say whether an address has an
            account, so a typo just means an invitation nobody receives.
          </p>
          <ul className="plain">
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
