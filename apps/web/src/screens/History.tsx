/**
 * The history drawer (07 §1, 02 §3): the game's public log, oldest first, each entry drawn by the
 * module's `HistoryItem`, which is given the stored text to fall back on for a record it can't
 * draw (02 §3); the drawer itself never shows that text beside the module's own drawing. Pages
 * are fetched in turn until the log is complete or the cap is reached; the newest entries are at
 * the bottom, and the list is scrolled to them when it opens.
 */
import type { ApiClient } from "@your-move/api-client";
import type { GameClientModule } from "@your-move/sdk/client";
import { useEffect, useRef, useState } from "react";

import { Dialog } from "../Dialog.js";
import { type GameEnvelope, getHistory, type HistoryItem } from "../game-api.js";
import { namesBySeat } from "../game-text.js";

const MAX_PAGES = 20;

interface HistoryProps {
  readonly api: ApiClient;
  readonly game: GameEnvelope;
  readonly client: GameClientModule;
  readonly onClose: () => void;
  readonly onSessionLost: () => void;
}

export function History({ api, game, client, onClose, onSessionLost }: HistoryProps) {
  const [items, setItems] = useState<readonly HistoryItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const names = namesBySeat(game.players);
  const newest = useRef<HTMLLIElement>(null);
  const { id } = game;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const all: HistoryItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await getHistory(api, id, cursor);
        if (cancelled) return;
        if (!result.ok) {
          if (result.status === 401) onSessionLost();
          setProblem(
            result.status === 0
              ? "You seem to be offline. Check your connection and try again."
              : "Couldn't load the history. Please try again.",
          );
          return;
        }
        all.push(...result.data.items);
        if (result.data.nextCursor === null) break;
        cursor = result.data.nextCursor;
      }
      setProblem(null);
      setItems(all);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [api, id, attempt, onSessionLost]);

  const loaded = items !== null;
  useEffect(() => {
    if (loaded) newest.current?.scrollIntoView?.({ block: "end" });
  }, [loaded]);

  return (
    <Dialog title="History" onClose={onClose} variant="drawer">
      {problem === null ? null : (
        <div className="stack">
          <p role="alert" className="problem">
            {problem}
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setProblem(null);
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {items === null && problem === null ? <p role="status">Loading…</p> : null}
      {items?.length === 0 ? <p>Nothing has happened yet.</p> : null}
      {items === null || items.length === 0 ? null : (
        <ol className="history" aria-label="Moves, oldest first">
          {items.map((item, index) => (
            <li key={item.seq} ref={index === items.length - 1 ? newest : undefined}>
              <client.HistoryItem
                record={item.record}
                describe={item.describe}
                gameVersion={game.gameVersion}
                names={names}
              />
              {item.via === "token" ? <span className="badge quiet">AI</span> : null}
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="button secondary" onClick={onClose}>
        Close
      </button>
    </Dialog>
  );
}
