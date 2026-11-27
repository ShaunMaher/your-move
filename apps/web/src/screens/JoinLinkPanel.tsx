/**
 * The lobby's join-link controls, for its creator (07 §1, 06 §6.8): whether a link works and until
 * when, create, rotate and revoke, and the link itself shown once, right after it is made, with
 * Share and Copy. The URL is never fetched again: the server returns it only when it makes one.
 */
import { useState } from "react";

import type { GameEnvelope } from "../game-api.js";

/** What making a link answered: its URL, or what went wrong. */
export type MadeLink = { readonly url: string } | { readonly problem: string };

interface JoinLinkPanelProps {
  readonly link: GameEnvelope["joinLink"];
  /** A link made just before this screen opened (at creation), to show once. */
  readonly fresh: string | null;
  readonly onCreate: () => Promise<MadeLink>;
  readonly onRevoke: () => Promise<string | null>;
  /** Shows what went wrong (or clears it) in the lobby's one alert region. */
  readonly onProblem: (message: string | null) => void;
}

const until = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function JoinLinkPanel({ link, fresh, onCreate, onRevoke, onProblem }: JoinLinkPanelProps) {
  const [url, setUrl] = useState<string | null>(fresh);
  const [pending, setPending] = useState<"create" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const active = link?.active === true;
  const canShare = typeof navigator.share === "function";

  async function create() {
    if (pending !== null) return;
    setPending("create");
    onProblem(null);
    setCopied(false);
    const made = await onCreate();
    setPending(null);
    if ("url" in made) setUrl(made.url);
    else onProblem(made.problem);
  }

  async function revoke() {
    if (pending !== null) return;
    setPending("revoke");
    onProblem(null);
    const failure = await onRevoke();
    setPending(null);
    onProblem(failure);
    if (failure === null) setUrl(null);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      onProblem("Couldn't copy the link. Select it and copy it yourself.");
    }
  }

  async function share(text: string) {
    try {
      await navigator.share({ url: text });
    } catch {
      // Dismissed, or the share sheet failed: the link is still on screen to copy.
    }
  }

  return (
    <section className="card stack" aria-labelledby="join-link-heading">
      <h2 id="join-link-heading">Join link</h2>
      {url === null ? null : (
        <div className="stack">
          <div className="field">
            <label htmlFor="join-link-url">Share this link with the people you want to play</label>
            <input
              id="join-link-url"
              type="text"
              readOnly
              value={url}
              aria-describedby="join-link-once"
              onFocus={(event) => {
                event.currentTarget.select();
              }}
            />
          </div>
          <p id="join-link-once" className="hint">
            It&apos;s shown only now. If you lose it, make a new one: the old one then stops
            working.
          </p>
          <div className="row">
            {canShare ? (
              <button type="button" className="button" onClick={() => void share(url)}>
                Share link
              </button>
            ) : null}
            <button
              type="button"
              className={canShare ? "button secondary" : "button"}
              onClick={() => void copy(url)}
            >
              Copy link
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setUrl(null);
                setCopied(false);
              }}
            >
              Done
            </button>
          </div>
          <p role="status">{copied ? "Link copied." : ""}</p>
        </div>
      )}
      <p>
        {active && link.expiresAt !== null
          ? `Link active until ${until.format(new Date(link.expiresAt))}.`
          : "There's no join link for this game."}
      </p>
      <p className="hint">
        Anyone with the link can see this game and the names of the players who have joined, and
        take an open seat. Share it only with people you know. The game waits for you to press
        Start, and you can remove anyone before you do.
      </p>
      <div className="row">
        <button
          type="button"
          className={active ? "button secondary" : "button"}
          disabled={pending !== null}
          onClick={() => void create()}
        >
          {pending === "create"
            ? "Making a link…"
            : active
              ? "Make a new link"
              : "Make a join link"}
        </button>
        {active ? (
          <button
            type="button"
            className="button secondary"
            disabled={pending !== null}
            onClick={() => void revoke()}
          >
            {pending === "revoke" ? "Turning it off…" : "Turn the link off"}
          </button>
        ) : null}
      </div>
    </section>
  );
}
