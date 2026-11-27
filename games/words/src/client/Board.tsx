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
import { isGameError, shuffle, type GameError } from "@your-move/sdk";
import { formatText, type BoardProps } from "@your-move/sdk/client";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement } from "react";

import {
  analyseViewPlay,
  engines,
  findRuleset,
  tilePoints,
  type Action,
  type Lexicon,
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
import { useNoPlayHint } from "./hint.js";
import { Rack } from "./Rack.js";
import { webCryptoRandom } from "./random.js";
import { clearOrder, loadOrder, rackOrderKey, saveOrder } from "./storage.js";
import { installStyles } from "./styles.js";
import {
  cancelBlank,
  initial,
  move,
  onRack,
  placedCount,
  recall,
  reconcile,
  reorder,
  setBlankLetter,
  squareKey,
  toPlacements,
  type Source,
  type Target,
  type Tentative,
} from "./tentative.js";
import { errorText, plural, seatNames, shown } from "./text.js";
import { Unsupported } from "./Unsupported.js";

/**
 * The contract's props, plus the game's `public` word list for the no-play hint (words §10.8).
 * The contract has no channel for the list yet (07 §4), so the shell doesn't pass it and the hint
 * stays silent in the app until one is specified.
 */
type Props = BoardProps<Action, View, PreviewResult> & { readonly lexicon?: Lexicon | null };

const NO_TILES: readonly string[] = [];
const PREVIEW_DELAY_MS = 250;
/** Longer for a list only the server holds: every check is a request (05 §Rate limits). */
const SERVER_PREVIEW_DELAY_MS = 600;
const HOVER_ZOOM_MS = 300;
const DRAG_SLOP = 6;
const TOUCH_GHOST_OFFSET = 56;
const SUBMIT_FAILED = "Couldn't send your play. Check your connection and try again.";

/** What the shell's preview said about the tiles on the board. */
type Answer = PreviewResult | GameError | "unchecked";

/** The answers that refuse a play; any other error says only that the check didn't happen. */
const REFUSALS: ReadonlySet<string> = new Set(["INVALID_WORDS", "INVALID_PLACEMENT"]);
const MAX_ANSWERS = 64;

function isRefusal(answer: Answer | null): answer is GameError {
  return (
    answer !== null && answer !== "unchecked" && isGameError(answer) && REFUSALS.has(answer.code)
  );
}

type Engine = (typeof engines)[keyof typeof engines];

/** The engine for a game's rules version, if this app has it. */
function engineFor(version: number): Engine | undefined {
  const known: Readonly<Record<number, Engine>> = engines;
  return Object.hasOwn(known, version) ? known[version] : undefined;
}

export function Board(props: Props): ReactElement {
  const { game, view } = props;
  const [styled] = useState(installStyles);
  const ruleset = findRuleset(view.ruleset.id, view.ruleset.version);
  const engine = engineFor(game.gameVersion);
  if (!styled) return <Unsupported />;
  if (ruleset === undefined || engine === undefined) {
    return (
      <p role="alert">
        This game uses a version of the rules this app doesn&apos;t know. Reload the page to update.
      </p>
    );
  }
  // The tentative tiles belong to one game and survive its new versions (see `reconcile`).
  return <Table key={game.id} {...props} ruleset={ruleset} engine={engine} />;
}

function Table(
  props: Props & {
    readonly ruleset: Ruleset;
    readonly engine: Engine;
  },
): ReactElement {
  const { game, view, ruleset, engine } = props;
  const rack = view.yourRack ?? NO_TILES;
  const names = seatNames(game, view.scores.length);
  const storageKey = rackOrderKey(game);
  const canArrange = view.yourRack !== null && view.final === undefined && game.status === "active";
  const canAct = canArrange && game.yourTurn;
  const points = (tile: string): number => tilePoints(ruleset, tile);
  const noPlay = useNoPlayHint({
    active: canAct,
    version: game.version,
    ruleset,
    view,
    lexicon: props.lexicon ?? null,
  });

  const [t, setT] = useState<Tentative>(() =>
    initial(rack, canArrange ? loadOrder(storageKey, rack.length) : null),
  );
  const [selected, setSelected] = useState<Source | null>(null);
  const [viewport, setViewport] = useState<Viewport>(FIT);
  const [dialog, setDialog] = useState<"swap" | "pass" | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [answers, setAnswers] = useState<ReadonlyMap<string, Answer>>(new Map());
  const [ghost, setGhost] = useState<{ tile: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // A new view of the game (an opponent played, a refetch): keep what the player arranged where
  // it still makes sense, and forget what was waiting on the old view. Done while rendering, so
  // no frame ever pairs the old tiles with the new rack.
  const [seen, setSeen] = useState({ version: game.version, rack });
  if (seen.version !== game.version) {
    setSeen({ version: game.version, rack });
    setT((now) =>
      reconcile(now, seen.rack, rack, (key) => {
        const [row = 0, col = 0] = key.split(",").map(Number);
        return view.board[row]?.[col] != null;
      }),
    );
    setSelected(null);
    setDialog(null);
    setSent(false);
    setMessage(null);
    setAnswers(new Map());
  }
  // A dialog is for acting: when the turn passes (or the game ends) with one open, it closes.
  if (!canAct && dialog !== null) setDialog(null);

  const frame = useRef<HTMLDivElement>(null);
  const rackBox = useRef<HTMLDivElement>(null);
  const preview = useRef(props.preview);
  const live = useRef({ viewport, t });
  const dragged = useRef(false);
  const dragging = useRef(false);
  const arranged = useRef(false);
  useEffect(() => {
    preview.current = props.preview;
    live.current = { viewport, t };
  });

  // The saved order is written only after the player reorders, and only while the game is on; a
  // game that is over keeps nothing.
  useEffect(() => {
    if (!canArrange) clearOrder(storageKey);
    else if (arranged.current) saveOrder(storageKey, t.order);
  }, [canArrange, storageKey, t.order]);
  // A new rack means the saved order no longer describes it.
  const rackKey = rack.join("");
  const lastRack = useRef(rackKey);
  useEffect(() => {
    if (lastRack.current === rackKey) return;
    lastRack.current = rackKey;
    if (!arranged.current) clearOrder(storageKey);
  }, [rackKey, storageKey]);

  const placements = useMemo(() => toPlacements(t, rack), [t, rack]);
  const analysis = useMemo(
    () => (placements.length === 0 ? null : analyseViewPlay(view, placements)),
    [view, placements],
  );
  const playable = analysis !== null && !isGameError(analysis);
  // An answer holds for one version of the game and one set of tiles.
  const checkKey = `${String(game.version)}:${JSON.stringify(placements)}`;
  const answer = answers.get(checkKey) ?? null;
  const settled = answer !== null && answer !== "unchecked";
  const refused = isRefusal(answer) ? answer : null;
  // A server-only list is checked over the network: ask less often.
  const delay = game.resources.some((r) => r.distribution === "serverOnly")
    ? SERVER_PREVIEW_DELAY_MS
    : PREVIEW_DELAY_MS;

  useEffect(() => {
    if (!canAct || !playable || settled) return;
    const timer = setTimeout(() => {
      const remember = (result: Answer): void => {
        setAnswers((now) => {
          const next = new Map(now).set(checkKey, result);
          // A bounded cache: the oldest answers go first.
          for (const key of next.keys()) {
            if (next.size <= MAX_ANSWERS) break;
            next.delete(key);
          }
          return next;
        });
      };
      preview
        .current({ type: "play", placements })
        .then(
          (result) => {
            // Only a real answer is kept; a rate limit, a stale game or a lost connection says
            // nothing about the words, so the server decides when the player plays.
            remember(isGameError(result) && !REFUSALS.has(result.code) ? "unchecked" : result);
          },
          () => {
            remember("unchecked");
          },
        )
        .catch(() => undefined);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [canAct, playable, settled, checkKey, placements, delay]);

  function clearTransient(): void {
    setSelected(null);
    setMessage(null);
  }

  function put(source: Source, target: Target): void {
    if (target.kind === "rack") arranged.current = true;
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
    // One drag at a time: a second finger or button while one is live does nothing.
    if (dragging.current) return;
    dragging.current = true;
    const start = { x: event.clientX, y: event.clientY };
    const lift = event.pointerType === "touch" ? TOUCH_GHOST_OFFSET : 0;
    let moved = false;
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
      if (!moved && distance(start, at) < DRAG_SLOP) return;
      moved = true;
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
      dragging.current = false;
      stopHover();
      setGhost(null);
      setDropTarget(null);
      if (!moved) return;
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
    // Nothing is sent off turn, whatever a stale dialog or button says (07 §2).
    if (!canAct) return;
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
  const heldId =
    selected?.kind === "rack"
      ? selected.id
      : selected?.kind === "square"
        ? t.placed[selected.key]?.id
        : undefined;
  const heldRack = heldId === undefined ? undefined : rack[heldId];
  const held = heldRack === undefined ? null : heldName(heldRack);
  const turn = turnLine(game, names);
  const idle = !canAct || busy || sent;
  /** Where focus goes when a dialog closes and what opened it is gone: the board's own square. */
  const restoreTo = (): HTMLElement | null =>
    frame.current?.querySelector<HTMLElement>('[data-square][tabindex="0"]') ?? null;

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
      {turn !== null && (
        <p className="ym-w-turn" role="status" data-yours={game.yourTurn}>
          {turn}
        </p>
      )}
      <p className="ym-w-meta">
        {plural(view.bagCount, "tile", "tiles")} in the bag
        {view.lastMove === null ? "" : ` · ${formatText(engine.describe(view.lastMove), names)}`}
      </p>

      {view.final !== undefined && (
        <FinalSummary view={view} final={view.final} ruleset={ruleset} names={names} />
      )}

      <BoardGrid
        ruleset={ruleset}
        board={view.board}
        placed={placedView}
        planned={canArrange && !canAct}
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
              analysis={analysis}
              answer={answer}
              held={held}
              sent={sent}
              canAct={canAct}
              noPlay={noPlay}
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
                arranged.current = true;
                setT((now) => reorder(now, shuffle(now.order, webCryptoRandom)));
              }}
            >
              Shuffle
            </button>
            <button
              type="button"
              disabled={placedCount(t) === 0}
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
              disabled={idle || !playable || refused !== null}
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
          restoreTo={restoreTo}
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
          restoreTo={restoreTo}
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
          restoreTo={restoreTo}
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
          <span
            className="ym-w-tile"
            data-state={canArrange && !canAct ? "planned" : "placed"}
            data-blank={ghost.tile === "?"}
          >
            {shown(ghost.tile)}
          </span>
        </div>
      )}
    </section>
  );
}

/** Off turn, what the status line says about the tiles on the board. */
const PLANNING = "Not your turn yet. Tiles you place now are only a plan.";

/** A tile as the status line names it: "Tile A", "Blank tile". */
function heldName(tile: string): string {
  return tile === "?" ? "Blank tile" : `Tile ${shown(tile)}`;
}

/**
 * Whose turn it is, for the chip under the scores: "Your turn", "Sam's turn" or "Waiting for Sam
 * and Alex"; null when the game isn't under way or nobody is to act. It is the board's one
 * announcement of a change of turn (the status line below doesn't repeat it).
 */
function turnLine(game: Props["game"], names: readonly string[]): string | null {
  if (game.status !== "active" || game.toAct.length === 0) return null;
  if (game.yourTurn) return "Your turn";
  const acting = game.toAct.map((seat) => names[seat] ?? "");
  return acting.length === 1 ? `${acting[0] ?? ""}'s turn` : `Waiting for ${acting.join(" and ")}`;
}

/** The line under the board: what the tiles on the board would do, or what to do next. */
function Status(props: {
  readonly analysis: ReturnType<typeof analyseViewPlay> | null;
  readonly answer: Answer | null;
  readonly held: string | null;
  readonly sent: boolean;
  readonly canAct: boolean;
  /** The no-play hint, shown instead of the prompt while no tiles are on the board. */
  readonly noPlay: string | null;
}): ReactElement {
  const { analysis, answer, held } = props;
  // Selecting a tile (by tap or by keyboard) is announced, with what to do next.
  const holding = held === null ? null : <span>{held} selected. Choose a square.</span>;
  if (props.sent) return <span>Sent. Waiting for the board to update.</span>;
  // Off turn the tiles are a plan: the local score and the placement rules show, the word list
  // isn't asked (07 §2), and the line says so.
  const plan = props.canAct ? null : <span className="ym-w-meta">{PLANNING}</span>;
  if (analysis === null) {
    if (!props.canAct) {
      return (
        <>
          {holding}
          <span>{PLANNING}</span>
        </>
      );
    }
    return holding ?? <span>{props.noPlay ?? "Place tiles to make a word."}</span>;
  }
  if (isGameError(analysis)) {
    return (
      <>
        {holding}
        <span>{errorText(analysis)}</span>
        {plan}
      </>
    );
  }
  const words = analysis.words.map((w) => `${w.word.toUpperCase()} ${String(w.score)}`).join(", ");
  // An answer from before the turn passed is not shown while the tiles are only a plan.
  const current = props.canAct ? answer : null;
  const result =
    current !== null && current !== "unchecked" && !isGameError(current) ? current : null;
  const refusal = isRefusal(current) ? current : null;
  return (
    <>
      {holding}
      <span>
        <span className="ym-w-score">+{result?.score ?? analysis.score}</span> {words}
        {analysis.bingo ? " · uses every tile" : ""}
      </span>
      {props.canAct && answer === null && <span className="ym-w-meta">Checking the words…</span>}
      {props.canAct && answer === "unchecked" && (
        <span className="ym-w-meta">
          Couldn&apos;t check the words now; the server will when you play.
        </span>
      )}
      {refusal !== null && <span data-tone="bad">{errorText(refusal)}</span>}
      {result !== null && <span data-tone="ok">All words are in the word list.</span>}
      {plan}
    </>
  );
}
