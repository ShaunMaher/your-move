/**
 * The words board (docs/spec/07-frontend.md §2, 02 §3): scores, the board with zoom and pan, the
 * rack, tap-to-place and drag and drop, the blank-letter picker, a live preview of the play, and
 * the swap and pass dialogs. It talks to the server only through the shell's `submit` and
 * `preview`, and renders only what the view contains. Resigning is the shell's menu.
 *
 * Previews: the score and the placement rules come from the engine's view-level analysis, at
 * once, offline. Whether the words are in the dictionary comes from the shell's `preview` (local
 * when the shell has the list, else the server), debounced; until it answers, the score shows
 * alone (07 §3). Nothing here is authoritative: the server validates every play.
 */
import { isGameError, shuffle } from "@your-move/sdk";
import { formatText, type BoardProps } from "@your-move/sdk/client";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from "react";

import {
  analyseViewPlay,
  engines,
  findRuleset,
  tilePoints,
  type Action,
  type PreviewResult,
  type Ruleset,
  type View,
} from "../engine/index.js";
import { BoardGrid } from "./BoardGrid.js";
import { BlankPicker, PassDialog, SwapDialog } from "./Dialogs.js";
import { FinalSummary } from "./Final.js";
import {
  distance,
  FIT,
  nearestEmpty,
  squareAtPoint,
  TAP_SCALE,
  zoomAround,
  type Viewport,
} from "./geometry.js";
import { Rack } from "./Rack.js";
import { webCryptoRandom } from "./random.js";
import { installStyles } from "./styles.js";
import {
  cancelBlank,
  initial,
  move,
  onRack,
  recall,
  reorder,
  savedOrder,
  setBlankLetter,
  squareKey,
  toPlacements,
  type Source,
  type Target,
  type Tentative,
} from "./tentative.js";
import { errorText, plural, seatNames, shown } from "./text.js";

type Props = BoardProps<Action, View, PreviewResult>;

const NO_TILES: readonly string[] = [];
const PREVIEW_DELAY_MS = 250;
const HOVER_ZOOM_MS = 300;
const DRAG_SLOP = 6;
const TOUCH_GHOST_OFFSET = 56;
const SUBMIT_FAILED = "Couldn't send your play. Check your connection and try again.";

/** What the shell's preview said about the tiles on the board. */
interface Checked {
  readonly key: string;
  readonly answer: PreviewResult | { readonly code: string; readonly detail?: unknown } | "failed";
}

export function Board(props: Props): ReactElement {
  const { game, view } = props;
  useEffect(() => {
    installStyles();
  }, []);
  const ruleset = findRuleset(view.ruleset.id, view.ruleset.version);
  if (ruleset === undefined) {
    return (
      <p role="alert">
        This game uses a version of the rules this app doesn&apos;t know. Reload the page to update.
      </p>
    );
  }
  // A new version of the game (any play, a refetch) starts the tentative tiles afresh.
  return <Table key={`${game.id}:${String(game.version)}`} {...props} ruleset={ruleset} />;
}

function loadOrder(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveOrder(key: string, order: string): void {
  try {
    localStorage.setItem(key, order);
  } catch {
    // Best effort: the order is a convenience (07 §2).
  }
}

function Table(props: Props & { readonly ruleset: Ruleset }): ReactElement {
  const { game, view, ruleset } = props;
  const rack = view.yourRack ?? NO_TILES;
  const names = seatNames(game, view.scores.length);
  const storageKey = `words-rack:${game.id}`;
  const canArrange = view.yourRack !== null && view.final === undefined && game.status === "active";
  const canAct = canArrange && game.yourTurn;
  const points = (tile: string): number => tilePoints(ruleset, tile);

  const [t, setT] = useState<Tentative>(() => initial(rack, loadOrder(storageKey)));
  const [selected, setSelected] = useState<Source | null>(null);
  const [viewport, setViewport] = useState<Viewport>(FIT);
  const [dialog, setDialog] = useState<"swap" | "pass" | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [ghost, setGhost] = useState<{ tile: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const frame = useRef<HTMLDivElement>(null);
  const rackBox = useRef<HTMLDivElement>(null);
  const preview = useRef(props.preview);
  const live = useRef({ viewport, t });
  const dragged = useRef(false);
  useEffect(() => {
    preview.current = props.preview;
    live.current = { viewport, t };
  });
  useEffect(() => {
    saveOrder(storageKey, savedOrder(t, rack));
  }, [storageKey, t, rack]);

  const placements = useMemo(() => toPlacements(t, rack), [t, rack]);
  const analysis = useMemo(
    () => (placements.length === 0 ? null : analyseViewPlay(view, placements)),
    [view, placements],
  );
  const playable = analysis !== null && !isGameError(analysis);
  const checkKey = JSON.stringify(placements);

  useEffect(() => {
    if (!canAct || !playable) return;
    let current = true;
    const timer = setTimeout(() => {
      preview
        .current({ type: "play", placements })
        .then(
          (answer) => {
            if (current) setChecked({ key: checkKey, answer });
          },
          () => {
            if (current) setChecked({ key: checkKey, answer: "failed" });
          },
        )
        .catch(() => undefined);
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [canAct, playable, checkKey, placements]);

  const answer = checked?.key === checkKey ? checked.answer : null;
  const refused = answer !== null && answer !== "failed" && isGameError(answer) ? answer : null;

  function clearTransient(): void {
    setSelected(null);
    setMessage(null);
  }

  function put(source: Source, target: Target): void {
    setT((now) => move(now, rack, source, target));
    clearTransient();
  }

  function tapRack(id: number): void {
    if (dragged.current || !canArrange || busy) return;
    if (selected?.kind === "square") put(selected, { kind: "rack", before: id });
    else setSelected(selected?.kind === "rack" && selected.id === id ? null : { kind: "rack", id });
  }

  function tapSquare(key: string): void {
    if (dragged.current || !canArrange || busy) return;
    const [row = 0, col = 0] = key.split(",").map(Number);
    if (view.board[row]?.[col] != null) return;
    if (Object.hasOwn(t.placed, key)) {
      setSelected(
        selected?.kind === "square" && selected.key === key ? null : { kind: "square", key },
      );
    } else if (selected !== null) {
      put(selected, { kind: "square", key });
    }
  }

  function returnTile(key: string): void {
    put({ kind: "square", key }, { kind: "rack", before: null });
  }

  /** Where a drop at a screen point would land. */
  function locate(x: number, y: number, source: Source): Target | null {
    const box = frame.current?.getBoundingClientRect();
    const now = live.current;
    if (box && x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
      const spot = squareAtPoint(now.viewport, box.width, ruleset.boardSize, {
        x: x - box.left,
        y: y - box.top,
      });
      if (spot === null) return null;
      const own = source.kind === "square" ? source.key : null;
      const near = nearestEmpty(spot.row, spot.col, ruleset.boardSize, (r, c) => {
        const key = squareKey(r, c);
        return key === own || (view.board[r]?.[c] == null && !Object.hasOwn(now.t.placed, key));
      });
      return near === null ? null : { kind: "square", key: squareKey(near.row, near.col) };
    }
    const area = rackBox.current?.getBoundingClientRect();
    if (area && x >= area.left && x < area.right && y >= area.top && y < area.bottom) {
      const tiles = [...(rackBox.current?.querySelectorAll<HTMLElement>("[data-rack-id]") ?? [])];
      const before = tiles.find((tile) => {
        const r = tile.getBoundingClientRect();
        return x < r.left + r.width / 2 && y < r.bottom;
      });
      return {
        kind: "rack",
        before: before === undefined ? null : Number(before.dataset["rackId"]),
      };
    }
    return null;
  }

  /** Starts a possible drag of a tile; a press that doesn't travel stays a tap. */
  function beginDrag(source: Source, tile: string, event: PointerEvent<HTMLElement>): void {
    if (!canArrange || busy || (event.pointerType === "mouse" && event.button !== 0)) return;
    const start = { x: event.clientX, y: event.clientY };
    const lift = event.pointerType === "touch" ? TOUCH_GHOST_OFFSET : 0;
    let dragging = false;
    let hover: ReturnType<typeof setTimeout> | null = null;
    let at = start;
    const stopHover = (): void => {
      if (hover !== null) clearTimeout(hover);
      hover = null;
    };
    const aim = (): Target | null => locate(at.x, at.y - lift, source);
    const onMove = (e: globalThis.PointerEvent): void => {
      if (e.pointerId !== event.pointerId) return;
      at = { x: e.clientX, y: e.clientY };
      if (!dragging && distance(start, at) < DRAG_SLOP) return;
      dragging = true;
      setGhost({ tile, x: at.x, y: at.y - lift });
      const target = aim();
      setDropTarget(target?.kind === "square" ? target.key : null);
      const box = frame.current?.getBoundingClientRect();
      const over = target?.kind === "square";
      if (!over || live.current.viewport.scale > 1) {
        stopHover();
      } else if (hover === null && box !== undefined) {
        hover = setTimeout(() => {
          const around = { x: at.x - box.left, y: at.y - lift - box.top };
          setViewport((now) => zoomAround(now, box.width, around, TAP_SCALE));
        }, HOVER_ZOOM_MS);
      }
    };
    const finish = (e: globalThis.PointerEvent, drop: boolean): void => {
      if (e.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      stopHover();
      setGhost(null);
      setDropTarget(null);
      if (!dragging) return;
      dragged.current = true;
      setTimeout(() => {
        dragged.current = false;
      }, 0);
      const target = drop ? aim() : null;
      if (target !== null) put(source, target);
    };
    const onUp = (e: globalThis.PointerEvent): void => {
      finish(e, true);
    };
    const onCancel = (e: globalThis.PointerEvent): void => {
      finish(e, false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  async function send(action: Action): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await props.submit(action);
      if (outcome.ok) {
        setSent(true);
        setDialog(null);
      } else {
        setMessage(errorText(outcome.error));
        setDialog(null);
      }
    } catch {
      setMessage(SUBMIT_FAILED);
    } finally {
      setBusy(false);
    }
  }

  const placedView = Object.fromEntries(
    Object.entries(t.placed).map(([key, item]) => [key, { put: item, tile: rack[item.id] ?? "" }]),
  );
  const last = new Set(
    view.lastMove?.type === "play"
      ? view.lastMove.placements.map((p) => squareKey(p.row, p.col))
      : [],
  );
  const heldTile = selected?.kind === "rack" ? selected.id : null;
  const idle = !canAct || busy || sent;
  const refusedWords = refused !== null;

  return (
    <section className="ym-w" aria-label="Words board">
      <ul className="ym-w-scores" aria-label="Scores">
        {names.map((name, seat) => (
          <li key={seat} aria-current={game.toAct.includes(seat)}>
            {name}
            {seat === game.yourSeat ? " (you)" : ""} {String(view.scores[seat] ?? 0)}
          </li>
        ))}
      </ul>
      <p className="ym-w-meta">
        {plural(view.bagCount, "tile", "tiles")} in the bag
        {view.lastMove === null
          ? ""
          : ` · ${formatText(engines[1].describe(view.lastMove), names)}`}
      </p>

      {view.final !== undefined && (
        <FinalSummary view={view} final={view.final} ruleset={ruleset} names={names} />
      )}

      <BoardGrid
        ruleset={ruleset}
        board={view.board}
        placed={placedView}
        last={last}
        selected={selected?.kind === "square" ? selected.key : null}
        holding={selected !== null}
        viewport={viewport}
        onViewport={setViewport}
        frame={frame}
        onSquare={tapSquare}
        onReturn={returnTile}
        onTileDown={(key, event) => {
          beginDrag({ kind: "square", key }, rack[t.placed[key]?.id ?? -1] ?? "", event);
        }}
        dropTarget={dropTarget}
      />

      {canArrange && (
        <>
          <div className="ym-w-status" aria-live="polite" aria-atomic="true">
            <Status
              names={names}
              game={game}
              placed={placements.length}
              analysis={analysis}
              checked={answer}
              sent={sent}
              canAct={canAct}
            />
          </div>
          {message !== null && (
            <p role="alert" className="ym-w-status" data-tone="bad">
              {message}
            </p>
          )}
          <Rack
            tiles={rack}
            ids={onRack(t)}
            points={points}
            selected={heldTile}
            canReturn={selected?.kind === "square"}
            container={rackBox}
            onTap={tapRack}
            onReturn={() => {
              if (selected?.kind === "square") returnTile(selected.key);
            }}
            onTileDown={(id, event) => {
              beginDrag({ kind: "rack", id }, rack[id] ?? "", event);
            }}
          />
          <div className="ym-w-actions" role="group" aria-label="Actions">
            <button
              type="button"
              onClick={() => {
                setT((now) => reorder(now, shuffle(now.order, webCryptoRandom)));
              }}
            >
              Shuffle
            </button>
            <button
              type="button"
              disabled={placements.length === 0 && Object.keys(t.placed).length === 0}
              onClick={() => {
                setT(recall);
                clearTransient();
              }}
            >
              Recall
            </button>
            <button
              type="button"
              disabled={idle}
              onClick={() => {
                setDialog("swap");
              }}
            >
              Swap
            </button>
            <button
              type="button"
              disabled={idle}
              onClick={() => {
                setDialog("pass");
              }}
            >
              Pass
            </button>
            <button
              type="button"
              className="ym-w-primary"
              disabled={idle || !playable || refusedWords}
              onClick={() => {
                void send({ type: "play", placements });
              }}
            >
              Play
            </button>
          </div>
        </>
      )}

      {t.blankFor !== null && (
        <BlankPicker
          onPick={(letter) => {
            setT((now) => setBlankLetter(now, letter));
          }}
          onCancel={() => {
            setT(cancelBlank);
          }}
        />
      )}
      {dialog === "swap" && (
        <SwapDialog
          rack={rack}
          points={points}
          swapMinBag={ruleset.swapMinBag}
          bagCount={view.bagCount}
          busy={busy}
          onSwap={(tiles) => {
            void send({ type: "swap", tiles: [...tiles] });
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      )}
      {dialog === "pass" && (
        <PassDialog
          busy={busy}
          onPass={() => {
            void send({ type: "pass" });
          }}
          onCancel={() => {
            setDialog(null);
          }}
        />
      )}
      {ghost !== null && (
        <div
          className="ym-w-ghost"
          aria-hidden="true"
          ref={(element) => {
            if (element) {
              element.style.left = `${String(ghost.x)}px`;
              element.style.top = `${String(ghost.y)}px`;
            }
          }}
        >
          <span className="ym-w-tile" data-state="placed" data-blank={ghost.tile === "?"}>
            {shown(ghost.tile)}
          </span>
        </div>
      )}
    </section>
  );
}

/** The line under the board: whose turn it is, or what the tiles on the board would do. */
function Status(props: {
  readonly names: readonly string[];
  readonly game: Props["game"];
  readonly placed: number;
  readonly analysis: ReturnType<typeof analyseViewPlay> | null;
  readonly checked: Checked["answer"] | null;
  readonly sent: boolean;
  readonly canAct: boolean;
}): ReactElement {
  const { analysis, checked } = props;
  if (props.sent) return <span>Sent. Waiting for the board to update.</span>;
  if (analysis === null) {
    if (props.canAct) return <span>Your turn. Place tiles to make a word.</span>;
    const waiting = props.game.toAct.map((seat) => props.names[seat] ?? "").join(", ");
    return (
      <span>
        {waiting === ""
          ? "Plan your next play."
          : `Waiting for ${waiting}. You can plan your next play.`}
      </span>
    );
  }
  if (isGameError(analysis)) return <span>{errorText(analysis)}</span>;
  const words = analysis.words.map((w) => `${w.word.toUpperCase()} ${String(w.score)}`).join(", ");
  const score =
    checked !== null && checked !== "failed" && !isGameError(checked)
      ? checked.score
      : analysis.score;
  return (
    <>
      <span>
        <span className="ym-w-score">+{score}</span> {words}
        {analysis.bingo ? " · uses every tile" : ""}
      </span>
      {props.canAct && checked === null && <span className="ym-w-meta">Checking the words…</span>}
      {checked === "failed" && (
        <span className="ym-w-meta">
          Couldn&apos;t check the words now; the server will when you play.
        </span>
      )}
      {checked !== null && checked !== "failed" && isGameError(checked) && (
        <span data-tone="bad">{errorText(checked)}</span>
      )}
      {checked !== null && checked !== "failed" && !isGameError(checked) && (
        <span data-tone="ok">All words are in the word list.</span>
      )}
    </>
  );
}
