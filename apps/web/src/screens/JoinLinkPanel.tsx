/**
 * The lobby's join-link controls, for its creator (07 §1, 06 §6.8): whether a link works and until
 * when, create, rotate and revoke, and the link itself shown once, right after it is made, with
 * Share and Copy. The URL is never fetched again: the server returns it only when it makes one.
 * While a link works, making a new one or turning it off is confirmed first: either stops the
 * link already shared.
 */
import { useState } from "react";

import { Dialog } from "../Dialog.js";
import type { GameEnvelope } from "../game-api.js";
import { linkUntil } from "../text.js";

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

export function JoinLinkPanel({ link, fresh, onCreate, onRevoke, onProblem }: JoinLinkPanelProps) {
  const [url, setUrl] = useState<string | null>(fresh);
  const [pending, setPending] = useState<"create" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  /** Which change to a working link is being confirmed. */
  const [confirming, setConfirming] = useState<"create" | "revoke" | null>(null);
  const active = link?.active === true;
  const canShare = typeof navigator.share === "function";

  async function create() {
    if (pending !== null) return;
    setConfirming(null);
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
    setConfirming(null);
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
          ? `Link active until ${linkUntil(link.expiresAt)}.`
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
          onClick={() => {
            if (active) setConfirming("create");
            else void create();
          }}
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
            onClick={() => {
              setConfirming("revoke");
            }}
          >
            {pending === "revoke" ? "Turning it off…" : "Turn the link off"}
          </button>
        ) : null}
      </div>
      {confirming === null ? null : (
        <Dialog
          title={confirming === "create" ? "Make a new link?" : "Turn the link off?"}
          dismissible
          onClose={() => {
            setConfirming(null);
          }}
        >
          <p>
            {confirming === "create"
              ? "The link you've shared will stop working; you'll get a new one to share instead."
              : "The link you've shared will stop working. Nobody who joined is removed."}
          </p>
          <div className="row">
            <button
              type="button"
              className="button danger"
              onClick={() => void (confirming === "create" ? create() : revoke())}
            >
              {confirming === "create" ? "Make a new link" : "Turn it off"}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setConfirming(null);
              }}
            >
              Keep this link
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
