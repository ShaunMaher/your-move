/**
 * The route-wide secrecy test (docs/spec/04-data-model.md invariant 4, 08 T8, A2 review S-2 and
 * P-4). Through whole games of the hidden-hand reference game and of words — lobbies created,
 * declined, cancelled and started; real word plays, a swap and previews; the frozen `declined`
 * ending; refusals and non-members' `404`s — every response of every game route, to every member,
 * is checked three ways:
 *
 * 1. no key names a secret column, and no stored secret appears in the body: the state, the
 *    recorded randomness, raw actions, other seats' final views, and each other seat's hidden
 *    pieces and the bag or deck on their own;
 * 2. **perturbation**: at every step, for every seated viewer, the other seats' hidden pieces and
 *    the bag or deck order are rewritten in the stored state, and every read must answer the viewer
 *    byte for byte as before — so even a partial leak (one tile, a count derived from the order)
 *    fails;
 * 3. **coverage**: every `/api/v1/games*`, `/api/v1/players*`, `/api/v1/join*` and
 *    `/api/v1/catalog` route the app registers must have been exercised, so a new route can't
 *    escape the test.
 */
import type { InstalledGame } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installedGames } from "../../../generated/server-registry.js";
import { nodeDictionaries } from "./dictionaries.js";
import { createGame, type ExampleView, gameHarness, type Player, signUp } from "./games-support.js";
import { type Harness, HOUR, MINUTE } from "./test-harness.js";

/** The served dictionaries the harness reads (built by the dictionary package). */
const DICTIONARIES = new URL("../../../packages/dictionary/generated/served", import.meta.url)
  .pathname;

/** The budget for the one test that plays a full game (11 §4: sized deliberately, not retried). */
const FULL_GAME_TIMEOUT_MS = 30_000;

let h: Harness;
/** Every route exercised, as `METHOD /path/:param`, for the coverage check. */
const exercised = new Set<string>();

beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

/**
 * Keys that would mean a secret column was serialised. `state` is also a player row's state
 * (`"playing"`, …), which is public; any other value under it is not.
 */
const PLAYER_STATES = new Set([
  "invited",
  "joined",
  "declined",
  "left",
  "removed",
  "playing",
  "out",
]);
const FORBIDDEN_KEYS = new Set([
  "state",
  "setupRng",
  "setup_rng",
  "rng",
  "action",
  "finalViews",
  "final_views",
  "writeToken",
  "write_token",
  "inviteEmail",
  "invite_email",
  "lastSeenVersion",
  // Hidden parts of the two games' states (racks and hands are public once a game is over).
  "bag",
  "deck",
  "pending",
]);

/** Every key in a JSON value that names a secret column or a hidden part of a state. */
function forbiddenKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) forbiddenKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      const playerState = key === "state" && typeof item === "string" && PLAYER_STATES.has(item);
      if (FORBIDDEN_KEYS.has(key) && !playerState) into.push(key);
      forbiddenKeys(item, into);
    }
  }
  return into;
}

interface StoredGame {
  readonly gameType: string;
  readonly state: string | null;
  readonly status: string;
}

function stored(gameId: string): StoredGame {
  const [row] = h.query("SELECT game_type, state, status FROM games WHERE id = ?", gameId);
  return {
    gameType: String(row?.["game_type"]),
    state: typeof row?.["state"] === "string" ? row["state"] : null,
    status: String(row?.["status"]),
  };
}

function seatOf(gameId: string, player: Player): number | null {
  const [row] = h.query(
    "SELECT seat FROM game_players WHERE game_id = ? AND user_id = ?",
    gameId,
    player.id,
  );
  return typeof row?.["seat"] === "number" ? row["seat"] : null;
}

interface WordsState {
  bag: string[];
  racks: string[][];
}
interface ExampleState {
  deck: number[];
  hands: number[][];
  pending: (number | null)[];
  discards: number[];
}

/** Long enough not to turn up in a body by chance (a short array like `[3]` could). */
const MIN_SECRET = 8;

/** Each other seat's hidden pieces, and the bag or deck, as stored now. */
function hiddenPieces(game: StoredGame, viewerSeat: number | null): string[] {
  if (game.state === null || game.status !== "active") return [];
  const state = JSON.parse(game.state) as Partial<WordsState & ExampleState>;
  const others = <T>(rows: readonly T[] | undefined) =>
    (rows ?? []).filter((_row, seat) => seat !== viewerSeat);
  return [
    ...others(state.racks).map((rack) => JSON.stringify(rack)),
    // A short list of numbers could match a list of scores by chance; perturbation covers those.
    ...others(state.hands)
      .filter((hand) => hand.length >= 4)
      .map((hand) => JSON.stringify(hand)),
    ...(state.bag === undefined ? [] : [JSON.stringify(state.bag)]),
    ...(state.deck === undefined ? [] : [JSON.stringify(state.deck)]),
  ];
}

/** The secrets of a game as stored now, each a string that must never appear in a response. */
function secretsOf(gameId: string, viewerSeat: number | null): string[] {
  const [game] = h.query("SELECT state, setup_rng, final_views FROM games WHERE id = ?", gameId);
  const secrets: string[] = [];
  for (const column of ["state", "setup_rng"]) {
    const value = game?.[column];
    if (typeof value === "string") secrets.push(value);
  }
  for (const row of h.query("SELECT action, rng FROM game_actions WHERE game_id = ?", gameId)) {
    for (const column of ["action", "rng"]) {
      const value = row[column];
      if (typeof value === "string") secrets.push(value);
    }
  }
  const finalViews = game?.["final_views"];
  if (typeof finalViews === "string") {
    secrets.push(finalViews);
    const parsed = JSON.parse(finalViews) as { seats: { view: unknown }[] };
    parsed.seats.forEach((entry, seat) => {
      if (seat !== viewerSeat) secrets.push(JSON.stringify(entry.view));
    });
  }
  secrets.push(...hiddenPieces(stored(gameId), viewerSeat));
  return secrets.filter((secret) => secret.length >= MIN_SECRET);
}

/** Checks one response body against the games' secrets for this viewer. */
function check(text: string, gameIds: readonly string[], viewer: Player, label: string): void {
  if (text === "") return;
  const body: unknown = JSON.parse(text);
  expect(forbiddenKeys(body), label).toEqual([]);
  for (const gameId of gameIds) {
    for (const secret of secretsOf(gameId, seatOf(gameId, viewer))) {
      expect(text.includes(secret), `${label}: contains a secret`).toBe(false);
    }
  }
  typedAddressesOnlyTheirOwn(body, text, viewer, label);
}

/** The address a game row holds as `invite_email`, per game, as stored now. */
function typedAddresses(gameId: string): string[] {
  return h
    .query("SELECT invite_email FROM game_players WHERE game_id = ?", gameId)
    .flatMap((row) => (typeof row["invite_email"] === "string" ? [row["invite_email"]] : []));
}

/**
 * Nobody's typed address appears anywhere but as `invitedAs` in an envelope of a game whose own
 * rows still hold that address, and only to that game's creator. Every address in the body must
 * be accounted for that way (A2 review S2-4).
 */
function typedAddressesOnlyTheirOwn(
  body: unknown,
  text: string,
  viewer: Player,
  label: string,
): void {
  let accounted = 0;
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const players = record["players"];
    if (typeof record["id"] === "string" && Array.isArray(players)) {
      for (const row of players as Record<string, unknown>[]) {
        const address = row["invitedAs"];
        if (typeof address !== "string") continue;
        expect(typedAddresses(record["id"]), `${label}: invitedAs is not stored`).toContain(
          address,
        );
        const [mine] = h.query(
          "SELECT joined_via FROM game_players WHERE game_id = ? AND user_id = ?",
          record["id"],
          viewer.id,
        );
        expect(mine?.["joined_via"], `${label}: invitedAs shown to a non-creator`).toBe("creator");
        accounted += 1;
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(body);
  expect(
    text.match(/[^"\s@]+@example\.org/gu)?.length ?? 0,
    `${label}: an unaccounted address`,
  ).toBe(accounted);
}

/** Every game of the scenario, so a list response is checked against all of them. */
let gamesInPlay: string[] = [];

/**
 * One request to a templated game route: records the route for the coverage check and checks the
 * response against every game's secrets for the caller.
 */
async function hit(
  player: Player,
  method: "GET" | "POST" | "DELETE",
  template: string,
  params: Record<string, string> = {},
  body?: unknown,
) {
  exercised.add(`${method} ${template}`);
  const path = template.replace(/:([a-zA-Z]+)/gu, (_match, name: string) => params[name] ?? "");
  const response = await h.request(method, path, body, { cookie: player.cookie });
  const text = await response.text();
  check(text, gamesInPlay, player, `${method} ${path} as ${player.name}`);
  return { status: response.status, text, json: (text === "" ? null : JSON.parse(text)) as Answer };
}

interface Answer {
  readonly game?: {
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly toAct: number[];
    readonly players: readonly { readonly seat: number | null; readonly userId: string | null }[];
  };
  readonly view?: unknown;
  readonly error?: { readonly code: string };
}

/** The read routes of one game for one viewer, bodies in a fixed order. */
async function reads(gameId: string, viewer: Player): Promise<string[]> {
  const bodies: string[] = [];
  for (const [template, params] of [
    ["/api/v1/games/:id", { id: gameId }],
    ["/api/v1/games/:id/history", { id: gameId }],
    ["/api/v1/games", {}],
    ["/api/v1/catalog", {}],
    ["/api/v1/players/recent", {}],
  ] as const) {
    bodies.push((await hit(viewer, "GET", template, params)).text);
  }
  for (const query of ["?invitations=true", "?invitations=hidden"]) {
    exercised.add("GET /api/v1/games");
    const response = await h.request("GET", `/api/v1/games${query}`, undefined, {
      cookie: viewer.cookie,
    });
    const text = await response.text();
    check(text, gamesInPlay, viewer, `GET /api/v1/games${query}`);
    bodies.push(text);
  }
  bodies.push(...(await repeatedWrites(gameId, viewer)));
  return bodies;
}

/**
 * The same preview and the same illegal action, as the viewer, each time `reads` runs, so a
 * perturbation that changes a refusal's body or a preview shows up too (A2 review S2-4). Both
 * name pieces no one holds, so they're refused or previewed from the viewer's own hand alone.
 */
async function repeatedWrites(gameId: string, viewer: Player): Promise<string[]> {
  const game = stored(gameId);
  if (game.status !== "active") return [];
  const action =
    game.gameType === "words"
      ? {
          type: "play",
          placements: [
            { row: 7, col: 7, tile: "Q" },
            { row: 7, col: 8, tile: "Z" },
          ],
        }
      : { card: 9999 };
  // The per-minute write limits would otherwise answer the later calls differently.
  h.advance(MINUTE);
  const [row] = h.query("SELECT version FROM games WHERE id = ?", gameId);
  const bodies: string[] = [];
  for (const [name, body] of [
    ["preview", { action }],
    ["actions", { expectedVersion: Number(row?.["version"]), action }],
  ] as const) {
    bodies.push(
      (await hit(viewer, "POST", `/api/v1/games/:id/${name}`, { id: gameId }, body)).text,
    );
  }
  return bodies;
}

/** A permutation that moves every item: the last one first (a no-op only if all are equal). */
function rotate<T>(items: readonly T[]): T[] {
  return items.length < 2 ? [...items] : [items[items.length - 1] as T, ...items.slice(0, -1)];
}

/** Deals `pool` back into groups of the given sizes, in order. */
function deal<T>(pool: readonly T[], sizes: readonly number[]): T[][] {
  let next = 0;
  return sizes.map((size) => {
    const group = pool.slice(next, next + size);
    next += size;
    return group;
  });
}

/**
 * The stored state with everything hidden from `viewerSeat` rearranged: the other seats' pieces
 * and the bag or deck pooled, rotated and dealt back in the same sizes. What the viewer may know —
 * their own pieces, the board, every count — is unchanged.
 */
function perturbed(game: StoredGame, viewerSeat: number): string | null {
  if (game.state === null || game.status !== "active") return null;
  const others = (seat: number) => seat !== viewerSeat;
  if (game.gameType === "words") {
    const state = JSON.parse(game.state) as WordsState;
    const hidden = state.racks.filter((_rack, seat) => others(seat));
    const pool = rotate([...hidden.flat(), ...state.bag]);
    const [bag = [], ...racks] = deal(pool, [state.bag.length, ...hidden.map((r) => r.length)]);
    let next = 0;
    return JSON.stringify({
      ...state,
      bag,
      racks: state.racks.map((rack, seat) => (others(seat) ? (racks[next++] ?? []) : rack)),
    });
  }
  const state = JSON.parse(game.state) as ExampleState;
  const hands = state.hands.filter((_hand, seat) => others(seat));
  const pending = state.pending.filter((card, seat) => others(seat) && card !== null) as number[];
  const pool = rotate([...hands.flat(), ...pending, ...state.deck, ...state.discards]);
  const [newHands, newPending, [deck = [], discards = []]] = (() => {
    const handGroups = deal(
      pool,
      hands.map((hand) => hand.length),
    );
    const rest = pool.slice(hands.flat().length);
    const pendingGroup = rest.slice(0, pending.length);
    const tail = rest.slice(pending.length);
    return [
      handGroups,
      pendingGroup,
      deal(tail, [state.deck.length, state.discards.length]),
    ] as const;
  })();
  let hand = 0;
  let play = 0;
  return JSON.stringify({
    ...state,
    deck,
    discards,
    hands: state.hands.map((own, seat) =>
      others(seat) ? [...(newHands[hand++] ?? [])].sort((a, b) => a - b) : own,
    ),
    pending: state.pending.map((card, seat) =>
      others(seat) && card !== null ? (newPending[play++] ?? card) : card,
    ),
  });
}

/**
 * The perturbation check: for every seated member, rearrange what they can't see and require
 * every read to answer them exactly as before. Returns how many viewers it compared.
 */
async function unchangedByHiddenState(gameId: string, players: readonly Player[]): Promise<number> {
  const game = stored(gameId);
  let compared = 0;
  for (const viewer of players) {
    const seat = seatOf(gameId, viewer);
    if (seat === null) continue;
    const changed = perturbed(game, seat);
    if (changed === null) continue;
    const before = await reads(gameId, viewer);
    h.exec("UPDATE games SET state = ? WHERE id = ?", changed, gameId);
    try {
      const after = await reads(gameId, viewer);
      expect(after, `${viewer.name} sees hidden state change`).toEqual(before);
    } finally {
      h.exec("UPDATE games SET state = ? WHERE id = ?", game.state, gameId);
    }
    compared += 1;
  }
  return compared;
}

/** Every route, as a member and as a stranger whose `404` bodies are checked too. */
async function readEverything(gameId: string, players: readonly Player[], stranger: Player) {
  for (const player of players) await reads(gameId, player);
  for (const template of ["/api/v1/games/:id", "/api/v1/games/:id/history"]) {
    const answer = await hit(stranger, "GET", template, { id: gameId });
    expect(answer.status).toBe(404);
  }
  const bodies: Record<string, unknown> = {
    actions: { expectedVersion: 0, action: { type: "pass" } },
    preview: { action: { type: "pass" } },
  };
  for (const name of [
    "actions",
    "preview",
    "start",
    "accept",
    "decline",
    "resign",
    "cancel",
    "rematch",
  ]) {
    const answer = await hit(
      stranger,
      "POST",
      `/api/v1/games/:id/${name}`,
      { id: gameId },
      bodies[name] ?? (name === "rematch" ? {} : { expectedVersion: 0 }),
    );
    expect([answer.status, answer.json.error?.code], name).toEqual([404, "NOT_FOUND"]);
  }
  const seen = await hit(
    stranger,
    "POST",
    "/api/v1/games/:id/seen",
    { id: gameId },
    {
      version: 0,
    },
  );
  expect(seen.status).toBe(404);
  for (const [method, template, body] of [
    ["POST", "/api/v1/games/:id/remove-seat", { expectedVersion: 0, playerId: "x" }],
    ["POST", "/api/v1/games/:id/join-link", {}],
    ["DELETE", "/api/v1/games/:id/join-link", undefined],
  ] as const) {
    const answer = await hit(stranger, method, template, { id: gameId }, body);
    expect([answer.status, answer.json.error?.code], template).toEqual([404, "NOT_FOUND"]);
  }
}

const version = async (gameId: string, player: Player): Promise<number> =>
  (await hit(player, "GET", "/api/v1/games/:id", { id: gameId })).json.game?.version ?? -1;

/** A lifecycle transition from the current version, its response checked. */
async function transition(gameId: string, player: Player, name: string) {
  return hit(
    player,
    "POST",
    `/api/v1/games/:id/${name}`,
    { id: gameId },
    {
      expectedVersion: await version(gameId, player),
    },
  );
}

async function created(player: Player, body: Record<string, unknown>): Promise<string> {
  // Five email invitees an hour per creator (08 §4).
  h.advance(HOUR);
  const answer = await hit(player, "POST", "/api/v1/games", {}, body);
  expect(answer.status, answer.text).toBe(201);
  const id = answer.json.game?.id ?? "";
  gamesInPlay.push(id);
  return id;
}

/** Whoever holds `seat` in the game. */
function playerAt(answer: Answer, seat: number | undefined, players: readonly Player[]): Player {
  const userId = answer.game?.players.find((row) => row.seat === seat)?.userId;
  const player = players.find((candidate) => candidate.id === userId);
  if (player === undefined) throw new Error("nobody holds that seat");
  return player;
}

// Words: real plays found in the built-in word list ------------------------------------------

interface WordsView {
  readonly board: ({ letter: string } | null)[][];
  readonly yourRack: string[] | null;
}

interface Placement {
  readonly row: number;
  readonly col: number;
  readonly tile: string;
  readonly letter?: string;
}

let wordList: string[] | undefined;
async function words(): Promise<string[]> {
  if (wordList === undefined) {
    const dictionaries = nodeDictionaries(DICTIONARIES);
    const manifest = dictionaries.index.dictionaries.find((entry) => entry.id === "enable");
    if (manifest === undefined) throw new Error("no built-in enable list");
    wordList = (await dictionaries.loadText(manifest)).split("\n").filter((w) => w.length > 1);
  }
  return wordList;
}

/** The rack tiles that spell `letters` (blanks standing in), or null. */
function spell(
  letters: string,
  rack: readonly string[],
): { tile: string; letter?: string }[] | null {
  const left = [...rack];
  const tiles: { tile: string; letter?: string }[] = [];
  for (const letter of letters) {
    const index = left.indexOf(letter);
    if (index >= 0) {
      left.splice(index, 1);
      tiles.push({ tile: letter });
      continue;
    }
    const blank = left.indexOf("?");
    if (blank < 0) return null;
    left.splice(blank, 1);
    tiles.push({ tile: "?", letter });
  }
  return tiles;
}

type Board = WordsView["board"];

/** The board turned on its diagonal: rows become columns. */
function transpose(board: Board): Board {
  return board.map((_row, r) => board.map((row) => row[r] ?? null));
}

/**
 * Words down through one letter already on the board, in a column with no tiles beside the new
 * ones and none just past either end, so the play forms only that word.
 */
function downThroughLetters(word: string, board: Board, rack: readonly string[]): Placement[][] {
  const size = board.length;
  const at = (r: number, c: number) => board[r]?.[c] ?? null;
  const plays: Placement[][] = [];
  board.forEach((row, r) => {
    row.forEach((square, c) => {
      if (square === null) return;
      const index = word.indexOf(square.letter);
      const top = r - index;
      if (index < 0 || top < 0 || top + word.length > size) return;
      if (at(top - 1, c) !== null || at(top + word.length, c) !== null) return;
      const rest: string[] = [];
      for (let i = 0; i < word.length; i++) {
        if (i === index) continue;
        const rr = top + i;
        if (at(rr, c) !== null || at(rr, c - 1) !== null || at(rr, c + 1) !== null) return;
        rest.push(word[i] ?? "");
      }
      const tiles = spell(rest.join(""), rack);
      if (tiles === null) return;
      const rows = Array.from({ length: word.length }, (_unused, i) => top + i).filter(
        (rr) => rr !== r,
      );
      plays.push(tiles.map((tile, i) => ({ row: rows[i] ?? 0, col: c, ...tile })));
    });
  });
  return plays;
}

/**
 * Candidate plays: on an empty board, words across the centre; otherwise words through one letter
 * already on the board, down or across.
 */
async function candidates(view: WordsView): Promise<Placement[][]> {
  const rack = view.yourRack ?? [];
  const size = view.board.length;
  const centre = Math.floor(size / 2);
  const empty = view.board.every((row) => row.every((square) => square === null));
  const across = transpose(view.board);
  const plays: Placement[][] = [];
  for (const word of await words()) {
    if (word.length > rack.length + (empty ? 0 : 1)) continue;
    if (empty) {
      const tiles = spell(word, rack);
      if (tiles === null) continue;
      for (let offset = 0; offset < word.length; offset++) {
        const start = centre - offset;
        if (start < 0 || start + word.length > size) continue;
        plays.push(tiles.map((tile, i) => ({ row: centre, col: start + i, ...tile })));
      }
    } else {
      plays.push(...downThroughLetters(word, view.board, rack));
      plays.push(
        ...downThroughLetters(word, across, rack).map((play) =>
          play.map((placement) => ({ ...placement, row: placement.col, col: placement.row })),
        ),
      );
    }
    if (plays.length >= 200) break;
  }
  return plays;
}

/**
 * Plays a real word for `player` if one is found — each candidate previewed first, as a client
 * would — and passes otherwise. Returns whether a word was played.
 */
async function playAWord(gameId: string, player: Player): Promise<boolean> {
  const view = (await hit(player, "GET", "/api/v1/games/:id", { id: gameId })).json
    .view as WordsView;
  let action: unknown = { type: "pass" };
  for (const placements of await candidates(view)) {
    const candidate = { type: "play", placements };
    const preview = await hit(
      player,
      "POST",
      "/api/v1/games/:id/preview",
      { id: gameId },
      {
        action: candidate,
      },
    );
    if (preview.status === 200) {
      action = candidate;
      break;
    }
  }
  const played = await hit(
    player,
    "POST",
    "/api/v1/games/:id/actions",
    { id: gameId },
    {
      expectedVersion: await version(gameId, player),
      action,
    },
  );
  expect(played.status, played.text).toBe(200);
  return (action as { type: string }).type === "play";
}

describe("route-wide secrecy (04 invariant 4)", () => {
  beforeEach(() => {
    gamesInPlay = [];
  });

  it("negative control: a view that leaks an opponent's cards fails the perturbation check", async () => {
    const example = installedGames.find((game) => game.manifest.type === "example");
    const engine = example?.engines[1];
    if (example === undefined || engine === undefined) throw new Error("no example game");
    const leaky: InstalledGame = {
      ...example,
      engines: {
        1: {
          ...engine,
          // The cards of another seat's hand, summed, in a field the schema allows.
          view: (state: { hands: number[][] }, viewer: number | null) => ({
            ...(engine.view as (state: unknown, viewer: number | null) => object)(state, viewer),
            deckCount: state.hands
              .filter((_hand, seat) => seat !== viewer)
              .flat()
              .reduce((sum, card) => sum + card, 0),
          }),
        },
      },
    };
    h.close();
    h = gameHarness({ ENABLED_GAMES: "example" }, { games: [leaky] });
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const game = await created(a, { gameType: "example", invitees: [{ email: b.email }] });
    expect((await transition(game, b, "accept")).json.game?.status).toBe("active");
    await expect(unchangedByHiddenState(game, [a, b])).rejects.toThrow(/sees hidden state change/u);
  });

  // A whole game over a real SQLite file in tmpdir (CI puts that on tmpfs): three sign-ups and
  // every route. It takes about 0.8 s unloaded (measured 2026-11-26), but more than Vitest's 5 s
  // default when the machine is busy.
  it(
    "the example game: lobbies, a full game with previews and refusals, the frozen declined ending",
    { timeout: FULL_GAME_TIMEOUT_MS },
    async () => {
      const players = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
      const [a, b, c] = players as [Player, Player, Player];
      const stranger = await signUp(h, "Stranger");

      // A lobby declined by one invitee (204) and cancelled by the creator.
      const cancelled = await created(a, {
        gameType: "example",
        seats: 3,
        invitees: [{ email: b.email }, { email: c.email }],
      });
      expect((await transition(cancelled, b, "decline")).status).toBe(204);
      expect((await transition(cancelled, a, "cancel")).status).toBe(200);
      await readEverything(cancelled, players, stranger);

      // A lobby started by the creator below the maximum: c's invitation is dropped.
      const startedByCreator = await created(a, {
        gameType: "example",
        seats: 3,
        invitees: [{ email: b.email }, { email: c.email }],
      });
      expect((await transition(startedByCreator, b, "accept")).status).toBe(200);
      expect((await transition(startedByCreator, a, "start")).status).toBe(200);
      await readEverything(startedByCreator, players, stranger);
      expect(await unchangedByHiddenState(startedByCreator, players)).toBe(2);

      // The frozen declined ending: one seat acts, the other declines before acting.
      const frozen = await created(a, { gameType: "example", invitees: [{ email: b.email }] });
      const accepted = await transition(frozen, b, "accept");
      expect(accepted.json.game?.status).toBe("active");
      const bCard = (accepted.json.view as ExampleView).seats[seatOf(frozen, b) ?? 0]?.hand?.[0];
      const played = await hit(
        b,
        "POST",
        "/api/v1/games/:id/actions",
        { id: frozen },
        {
          expectedVersion: await version(frozen, b),
          action: { card: bCard },
        },
      );
      expect(played.status, played.text).toBe(200);
      await unchangedByHiddenState(frozen, players);
      const declined = await transition(frozen, a, "decline");
      expect(declined.json.game?.status).toBe("declined");
      await readEverything(frozen, players, stranger);
      // Both members still see the game, each only their own final view.
      for (const viewer of [a, b]) {
        const own = await hit(viewer, "GET", "/api/v1/games/:id", { id: frozen });
        expect(own.json.view).not.toBeNull();
      }

      // A full three-player game with random seats: every step read, perturbed and refused.
      const game = await created(a, {
        gameType: "example",
        seats: 3,
        seatOrder: "random",
        options: { lives: 2 },
        invitees: [{ email: b.email }, { email: c.email }],
      });
      await readEverything(game, players, stranger);
      for (const who of [b, c]) await transition(game, who, "accept");
      let steps = 0;
      for (; steps < 300; steps++) {
        const now = (await hit(a, "GET", "/api/v1/games/:id", { id: game })).json;
        if (now.game?.status !== "active") break;
        // Not vacuous: there is something hidden to leak at every step.
        expect(hiddenPieces(stored(game), 0).length).toBeGreaterThan(0);
        if (steps % 3 === 0) {
          await readEverything(game, players, stranger);
          expect(await unchangedByHiddenState(game, players)).toBeGreaterThan(0);
        }
        const seat = now.game.toAct[0];
        const player = playerAt(now, seat, players);
        const { view } = (await hit(player, "GET", "/api/v1/games/:id", { id: game })).json;
        const hand = (view as ExampleView).seats[seat ?? 0]?.hand ?? [];
        const expectedVersion = now.game.version;
        // Refusals: a card not in hand, a stale version, and a seat that isn't to act.
        const notInHand = await hit(
          player,
          "POST",
          "/api/v1/games/:id/actions",
          { id: game },
          {
            expectedVersion,
            action: { card: 999 },
          },
        );
        expect(notInHand.status).toBe(400);
        const stale = await hit(
          player,
          "POST",
          "/api/v1/games/:id/actions",
          { id: game },
          {
            expectedVersion: expectedVersion - 1,
            action: { card: hand[0] },
          },
        );
        expect(stale.json.error?.code).toBe("STALE_GAME");
        await hit(
          player,
          "POST",
          "/api/v1/games/:id/preview",
          { id: game },
          {
            action: { card: hand[0] },
          },
        );
        const moved = await hit(
          player,
          "POST",
          "/api/v1/games/:id/actions",
          { id: game },
          {
            expectedVersion,
            action: { card: hand[0] },
          },
        );
        expect(moved.status, moved.text).toBe(200);
        await hit(
          player,
          "POST",
          "/api/v1/games/:id/seen",
          { id: game },
          {
            version: expectedVersion + 1,
          },
        );
      }
      expect(steps).toBeGreaterThan(3);
      expect(stored(game).status).toBe("finished");
      await readEverything(game, players, stranger);
      await hit(a, "GET", "/api/v1/games/types/:type/rules", { type: "example" });

      // Past opponents picked from the list: the game starts at creation (alpha A12), and the
      // creator's response is checked like every other.
      const recent = await hit(a, "GET", "/api/v1/players/recent");
      expect(recent.text).toContain(b.id);
      const rematch = await created(a, {
        gameType: "example",
        seats: 3,
        invitees: [{ userId: c.id }, { userId: b.id }],
      });
      expect(stored(rematch).status).toBe("active");
      await readEverything(rematch, players, stranger);
      expect(await unchangedByHiddenState(rematch, players)).toBe(3);

      // The finished game's own rematch (alpha A15): created by one player, answered to the
      // others with the same game, and shown on the finished game to its players only.
      h.advance(HOUR);
      const asked = await hit(b, "POST", "/api/v1/games/:id/rematch", { id: game }, {});
      expect(asked.status, asked.text).toBe(201);
      const again = asked.json.game?.id ?? "";
      gamesInPlay.push(again);
      for (const player of [a, c]) {
        const answer = await hit(player, "POST", "/api/v1/games/:id/rematch", { id: game }, {});
        expect([answer.status, answer.json.game?.id]).toEqual([200, again]);
      }
      for (const player of players) {
        const finishedGame = await hit(player, "GET", "/api/v1/games/:id", { id: game });
        expect(finishedGame.text).toContain(`"rematch":{"gameId":"${again}","you":"joined"}`);
      }
      // Nothing about it anywhere else: not in a list row, not to a stranger.
      for (const viewer of [...players, stranger]) {
        const listed = await hit(viewer, "GET", "/api/v1/games");
        expect(listed.text).not.toContain('"rematch"');
      }
      await readEverything(game, players, stranger);
      await readEverything(again, players, stranger);
      expect(await unchangedByHiddenState(again, players)).toBe(3);
    },
  );

  it("words: real plays, a swap, previews and a resignation", async () => {
    const players = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const [a, b] = players as [Player, Player];
    const stranger = await signUp(h, "Stranger");
    const game = await created(a, { gameType: "words", invitees: [{ email: b.email }] });
    await readEverything(game, players, stranger);
    await transition(game, b, "accept");
    const toAct = async () => {
      const now = (await hit(a, "GET", "/api/v1/games/:id", { id: game })).json;
      return playerAt(now, now.game?.toAct[0], players);
    };
    const step = async () => {
      await readEverything(game, players, stranger);
      expect(await unchangedByHiddenState(game, players)).toBe(2);
    };

    await step();
    // The opening: almost every rack spells a word across the centre; one that doesn't passes,
    // and the later turns make up the plays.
    let played = (await playAWord(game, await toAct())) ? 1 : 0;
    await step();
    // A swap: its record says how many tiles, never which.
    const swapper = await toAct();
    const rack =
      ((await hit(swapper, "GET", "/api/v1/games/:id", { id: game })).json.view as WordsView)
        .yourRack ?? [];
    const swapped = await hit(
      swapper,
      "POST",
      "/api/v1/games/:id/actions",
      { id: game },
      {
        expectedVersion: await version(game, swapper),
        action: { type: "swap", tiles: rack.slice(0, 3) },
      },
    );
    expect(swapped.status, swapped.text).toBe(200);
    await step();
    // Then words through the tiles on the board, until a second one is played.
    for (let turn = 0; turn < 8 && played < 2; turn++) {
      if (await playAWord(game, await toAct())) played += 1;
      await step();
    }
    expect(played).toBe(2);
    const resigned = await transition(game, await toAct(), "resign");
    expect(resigned.json.game?.status).toBe("finished");
    await readEverything(game, players, stranger);
    await hit(a, "GET", "/api/v1/games/types/:type/rules", { type: "words" });
    // A member's own final view is theirs to see; only another seat's is a secret.
    expect((await hit(b, "GET", "/api/v1/games/:id", { id: game })).json.view).not.toBeNull();
  });

  it("an email invite claimed at onboarding (alpha A17): the lobby before and after, then the game", async () => {
    const a = await signUp(h, "Ada");
    const stranger = await signUp(h, "Stranger");
    // An address with no account yet: an email-invite seat, its typed address the creator's only.
    const address = `newcomer-${crypto.randomUUID().slice(0, 8)}@example.org`;
    const game = await created(a, { gameType: "example", invitees: [{ email: address }] });
    await readEverything(game, [a], stranger);
    const before = await reads(game, a);

    // Onboarding with that address claims the seat; nothing the creator reads changes (02 §4).
    const newcomer = await signUp(h, "Newcomer", address);
    const players = [a, newcomer];
    expect(await reads(game, a)).toEqual(before);
    await readEverything(game, players, stranger);
    expect((await hit(newcomer, "GET", "/api/v1/games/:id", { id: game })).json.game?.status).toBe(
      "lobby",
    );

    // Accepting starts it; every read of the game is checked and perturbed as it is played.
    expect((await transition(game, newcomer, "accept")).json.game?.status).toBe("active");
    for (let step = 0; step < 3 && stored(game).status === "active"; step++) {
      await readEverything(game, players, stranger);
      expect(await unchangedByHiddenState(game, players)).toBe(2);
      const now = (await hit(a, "GET", "/api/v1/games/:id", { id: game })).json;
      const seat = now.game?.toAct[0];
      const player = playerAt(now, seat, players);
      const { view } = (await hit(player, "GET", "/api/v1/games/:id", { id: game })).json;
      const card = (view as ExampleView).seats[seat ?? 0]?.hand?.[0];
      const moved = await hit(
        player,
        "POST",
        "/api/v1/games/:id/actions",
        { id: game },
        { expectedVersion: now.game?.version, action: { card } },
      );
      expect(moved.status, moved.text).toBe(200);
    }
    await readEverything(game, players, stranger);
  });

  it("an email invite claimed in a three-seat lobby: another joined member reads the same before and after (review A17-S-10)", async () => {
    const [a, b] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const stranger = await signUp(h, "Stranger");
    const address = `newcomer-${crypto.randomUUID().slice(0, 8)}@example.org`;
    const game = await created(a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: address }],
    });
    expect((await transition(game, b, "accept")).json.game?.status).toBe("lobby");
    const before = { a: await reads(game, a), b: await reads(game, b) };

    const newcomer = await signUp(h, "Newcomer", address);
    expect(await reads(game, a)).toEqual(before.a);
    expect(await reads(game, b)).toEqual(before.b);
    await readEverything(game, [a, b, newcomer], stranger);

    // Accepting fills the last seat and starts the game; every read is checked and perturbed.
    expect((await transition(game, newcomer, "accept")).json.game?.status).toBe("active");
    await readEverything(game, [a, b, newcomer], stranger);
    expect(await unchangedByHiddenState(game, [a, b, newcomer])).toBe(3);
  });

  it("a join link (alpha A18): the lookup, joins, a rotation, a removal and a revoke, then the game", async () => {
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    const stranger = await signUp(h, "Stranger");
    const address = `typed-${crypto.randomUUID().slice(0, 8)}@example.org`;
    const made = await hit(
      a,
      "POST",
      "/api/v1/games",
      {},
      {
        gameType: "example",
        seats: 3,
        invitees: [{ email: address }],
        joinLink: true,
      },
    );
    expect(made.status, made.text).toBe(201);
    const game = made.json.game?.id ?? "";
    gamesInPlay.push(game);
    const tokenOf = (text: string) => /#([A-Za-z0-9_-]{22})"/u.exec(text)?.[1] ?? "";
    let token = tokenOf(made.text);
    const lookup = (who: Player) => hit(who, "POST", "/api/v1/join/lookup", {}, { token });
    const join = (who: Player) => hit(who, "POST", "/api/v1/join", {}, { token });
    expect((await lookup(b)).status).toBe(200);
    expect((await join(b)).status).toBe(200);
    await readEverything(game, [a, b], stranger);

    // A removal keeps b out, through this link and a rotated one; c takes the seat instead.
    const row = h.query(
      "SELECT id FROM game_players WHERE game_id = ? AND user_id = ?",
      game,
      b.id,
    );
    const removed = await hit(
      a,
      "POST",
      "/api/v1/games/:id/remove-seat",
      { id: game },
      {
        expectedVersion: await version(game, a),
        playerId: row[0]?.["id"],
      },
    );
    expect(removed.status, removed.text).toBe(200);
    expect((await join(b)).status).toBe(404);
    h.advance(MINUTE);
    const rotated = await hit(a, "POST", "/api/v1/games/:id/join-link", { id: game }, {});
    expect(rotated.status).toBe(200);
    token = tokenOf(rotated.text);
    expect((await join(b)).status).toBe(404);
    expect((await join(c)).status).toBe(200);
    await readEverything(game, [a, c], stranger);

    // Revoked: the typed address's seat stays, and the creator starts the game with who joined.
    expect((await hit(a, "DELETE", "/api/v1/games/:id/join-link", { id: game })).status).toBe(204);
    expect((await lookup(b)).status).toBe(404);
    expect((await transition(game, a, "start")).json.game?.status).toBe("active");
    const players = [a, c];
    for (let step = 0; step < 3 && stored(game).status === "active"; step++) {
      await readEverything(game, players, stranger);
      expect(await unchangedByHiddenState(game, players)).toBe(2);
      const now = (await hit(a, "GET", "/api/v1/games/:id", { id: game })).json;
      const seat = now.game?.toAct[0];
      const player = playerAt(now, seat, players);
      const { view } = (await hit(player, "GET", "/api/v1/games/:id", { id: game })).json;
      const card = (view as ExampleView).seats[seat ?? 0]?.hand?.[0];
      const moved = await hit(
        player,
        "POST",
        "/api/v1/games/:id/actions",
        { id: game },
        { expectedVersion: now.game?.version, action: { card } },
      );
      expect(moved.status, moved.text).toBe(200);
    }
    await readEverything(game, players, stranger);
  });

  it("perturbation can fail: a body that showed one hidden tile would differ", async () => {
    const players = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const [a, b] = players as [Player, Player];
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    gamesInPlay = [game.id];
    await transition(game.id, b, "accept");
    const before = stored(game.id);
    const seat = seatOf(game.id, a) ?? 0;
    const changed = JSON.parse(perturbed(before, seat) ?? "null") as WordsState;
    const original = JSON.parse(before.state ?? "null") as WordsState;
    // What a leak of the other seat's first tile, or of the bag's top, would show.
    expect([changed.racks[1 - seat], changed.bag.at(-1)]).not.toEqual([
      original.racks[1 - seat],
      original.bag.at(-1),
    ]);
    expect(changed.racks[seat]).toEqual(original.racks[seat]);
  });
});

describe("coverage (A2 review S-2)", () => {
  it("exercised every game route the app registers", () => {
    const registered = new Set(
      h
        .routes()
        .filter(
          (route) =>
            route.method !== "ALL" &&
            (route.path.startsWith("/api/v1/games") ||
              route.path.startsWith("/api/v1/players") ||
              route.path.startsWith("/api/v1/join") ||
              route.path === "/api/v1/catalog"),
        )
        .map((route) => `${route.method} ${route.path}`),
    );
    expect(registered.size).toBeGreaterThan(10);
    expect([...registered].filter((route) => !exercised.has(route)).sort()).toEqual([]);
    // And nothing exercised that the app doesn't have: the templates match Hono's own paths.
    expect([...exercised].filter((route) => !registered.has(route)).sort()).toEqual([]);
  });
});
