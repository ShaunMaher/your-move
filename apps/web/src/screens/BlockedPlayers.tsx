/**
 * Settings' *Blocked players* (07 §1, 05 §Blocks; alpha A23): the people you've blocked, newest
 * first, each with Unblock, which asks first. Nothing here is ever shown to the people listed.
 */
import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { Dialog } from "../Dialog.js";
import { type BlockedPlayer, listBlocks, unblockPlayer } from "../game-api.js";
import { blockedOn } from "../text.js";
import { Problem } from "./Problem.js";

interface BlockedPlayersProps {
  readonly api: ApiClient;
  /** A call answered 401: the session ended elsewhere. */
  readonly onSessionLost: () => void;
}

const nameOf = (player: BlockedPlayer): string => player.displayName ?? "A player";

export function BlockedPlayers({ api, onSessionLost }: BlockedPlayersProps) {
  const [blocks, setBlocks] = useState<readonly BlockedPlayer[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BlockedPlayer | null>(null);
  const [pending, setPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** What the last unblock did, announced (A23-P-12). */
  const [done, setDone] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Shows the first page as answered, after a load or an unblock. */
  const showFirst = useCallback(
    (result: Awaited<ReturnType<typeof listBlocks>>) => {
      if (!mounted.current) return;
      if (result.ok) {
        setBlocks(result.data.blocks);
        setNext(result.data.nextCursor);
        return;
      }
      if (result.status === 401) onSessionLost();
      else setProblem("Couldn't load the people you've blocked. Try again later.");
    },
    [onSessionLost],
  );

  useEffect(() => {
    void listBlocks(api).then(showFirst);
  }, [api, showFirst]);

  async function showMore() {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    const result = await listBlocks(api, next);
    if (!mounted.current) return;
    setLoadingMore(false);
    if (!result.ok) {
      if (result.status === 401) onSessionLost();
      else setProblem("Couldn't load more. Try again.");
      return;
    }
    setBlocks((now) => [...(now ?? []), ...result.data.blocks]);
    setNext(result.data.nextCursor);
  }

  async function unblock(player: BlockedPlayer) {
    if (pending) return;
    setPending(true);
    setProblem(null);
    setDone(null);
    const result = await unblockPlayer(api, player.userId);
    if (!mounted.current) return;
    setPending(false);
    setConfirming(null);
    // Already unblocked (another device) is as good as done.
    if (result.ok || result.status === 404) {
      showFirst(await listBlocks(api));
      // The row that had focus is gone: focus goes to the section, and the change is announced.
      setDone(`Unblocked ${nameOf(player)}.`);
      heading.current?.focus();
      return;
    }
    if (result.status === 401) {
      onSessionLost();
      return;
    }
    setProblem(
      result.status === 0
        ? "You seem to be offline. Check your connection and try again."
        : result.code === "RATE_LIMITED"
          ? "That's a lot at once. Wait a minute, then try again."
          : "Something went wrong. Please try again.",
    );
  }

  return (
    <section className="card stack" aria-labelledby="blocked-heading">
      <h2 id="blocked-heading" ref={heading} tabIndex={-1}>
        Blocked players
      </h2>
      <p role="status">{done}</p>
      <p className="hint">
        People you&apos;ve blocked can&apos;t add you to games or invite you, and you won&apos;t be
        put in a game with them. They aren&apos;t told.
      </p>
      {blocks === null ? (
        problem === null ? (
          <p role="status">Loading…</p>
        ) : null
      ) : blocks.length === 0 ? (
        <p>You haven&apos;t blocked anyone.</p>
      ) : (
        <ul className="plain">
          {blocks.map((player) => (
            <li key={player.userId} className="seat">
              <span>
                {nameOf(player)} <span className="hint">({blockedOn(player.createdAt)})</span>
              </span>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                aria-label={`Unblock ${nameOf(player)}`}
                onClick={() => {
                  setConfirming(player);
                }}
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
      {next === null ? null : (
        <button
          type="button"
          className="button secondary"
          disabled={loadingMore}
          onClick={() => void showMore()}
        >
          {loadingMore ? "Loading…" : "Show more"}
        </button>
      )}
      <Problem id="blocked-problem" message={problem} />
      {confirming === null ? null : (
        <Dialog
          title={`Unblock ${nameOf(confirming)}?`}
          dismissible={!pending}
          onClose={() => {
            setConfirming(null);
          }}
        >
          <p>
            They&apos;ll be able to invite you to games again. You won&apos;t be on each
            other&apos;s lists of people you&apos;ve played until you finish another game together.
          </p>
          <div className="row">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void unblock(confirming)}
            >
              {pending ? "Unblocking…" : "Unblock"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending}
              onClick={() => {
                setConfirming(null);
              }}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
