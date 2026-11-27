/**
 * The client's local preview (words §10.5, 07 §4) equals the engine's own `preview` on the full
 * state: over random reachable positions under every bundled ruleset, for plays the bot finds,
 * pieces of them, moved tiles and tiles dropped anywhere, with the real word list and with a
 * sparse one so that refused words are common. Same score, words and bingo, same error codes in
 * the same order.
 */
import { createWordList } from "@your-move/dictionary";
import { isGameError, recordRandom, type Resources } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import { options, realDictionary, realWordList, ruleset } from "../test-support.js";
import { previewViewPlay } from "./analysis.js";
import { wordsV1 as words } from "./definition.js";
import { view } from "./present.js";
import { preview } from "./rules.js";
import { RULESETS } from "./rulesets/index.js";
import type { Placement } from "./schemas.js";
import type { State } from "./state.js";

const GAMES = 25;
const BLANK_LETTERS = "etaoinsrhl";

let real: Resources;
beforeAll(async () => {
  real = (await realDictionary()).resources;
});

/** The real list with about a quarter of its words missing, by a hash of the word. */
function sparse(base: Resources): Resources {
  const has = (word: string): boolean => {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    return h % 4 !== 0 && base.dictionary?.has(word) === true;
  };
  return { dictionary: { id: "sparse", version: 1, has } };
}

describe.each([...RULESETS.keys()])("the local preview under the %s ruleset", (id) => {
  it("equals the engine's preview on random positions and placements", () => {
    const rules = ruleset(id);
    const opts = options(id);
    const kinds = new Map<string, number>();
    for (let game = 0; game < GAMES; game += 1) {
      const rng = seededRandom(1000 + game);
      let state: State = words.setup({
        options: opts,
        seats: 2,
        rng: recordRandom(seededRandom(game)).rng,
      });
      for (let step = 0; words.result(state) === null; step += 1) {
        const [seat] = words.toAct(state);
        if (seat === undefined) throw new Error("no seat to act");
        const action = words.test.randomAction(state, seat, rng, real);
        const rackNow = state.racks[seat] ?? [];
        const candidates: Placement[][] = [];
        if (action.type === "play") {
          const found = [...action.placements];
          candidates.push(found, found.slice(1), found.slice(0, -1), []);
          // A tile moved a square, and a play with another letter.
          candidates.push(found.map((p, i) => (i === 0 ? { ...p, col: p.col + 1 } : p)));
          candidates.push(found.map((p, i) => (i === 0 ? { ...p, row: p.row + 1 } : p)));
          candidates.push(
            found.map((p) =>
              p.tile === "?" ? { ...p, letter: BLANK_LETTERS[rng.nextInt(10)] } : p,
            ),
          );
        }
        // Tiles dropped anywhere, a few of them, from the rack or not.
        for (let k = 0; k < 4; k += 1) {
          const count = 1 + rng.nextInt(4);
          const drops: Placement[] = [];
          for (let n = 0; n < count; n += 1) {
            const tile = rng.nextInt(8) === 0 ? "z" : (rackNow[rng.nextInt(rackNow.length)] ?? "e");
            drops.push({
              row: rng.nextInt(rules.boardSize),
              col: rng.nextInt(rules.boardSize),
              tile,
              ...(tile === "?" ? { letter: BLANK_LETTERS[rng.nextInt(10)] } : {}),
            });
          }
          candidates.push(drops);
        }
        const mine = view(state, seat);
        for (const placements of candidates) {
          for (const list of [real, sparse(real)]) {
            const has = (word: string): boolean => list.dictionary?.has(word) === true;
            const server = preview(state, seat, { type: "play", placements }, list);
            const local = previewViewPlay(mine, placements, has);
            expect(local).toStrictEqual(server);
            const kind = isGameError(server) ? server.code : "ok";
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          }
        }
        const next = words.apply(state, seat, action, recordRandom(seededRandom(step)).rng);
        state = next.state;
      }
    }
    // The comparison covered good plays, refused words and broken placements.
    for (const kind of ["ok", "INVALID_WORDS", "INVALID_PLACEMENT"]) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe("the browser's word list", () => {
  it("agrees with the server's lookup, and so does the preview built on it", async () => {
    const all = await realWordList();
    const text = `${all.join("\n")}\n`;
    const set = new Set(all);
    // What the shell opens from the downloaded text (07 §4), and a plain set as the server's `has`.
    const browser = createWordList("enable", 1, text);
    const probes = [
      all[0] ?? "",
      all.at(-1) ?? "",
      ...all.filter((_, i) => i % 997 === 0),
      "",
      "a",
      "zzzzzz",
      "qxqx",
      "catz",
      "aaaaaaaaaaaaaa",
      "ca",
    ];
    for (const word of probes) expect(browser.has(word), word).toBe(set.has(word));
    expect(probes.some((w) => !set.has(w))).toBe(true);

    const rules = ruleset("classic");
    const [row, col] = rules.start;
    const state = words.setup({
      options: options("classic"),
      seats: 2,
      rng: recordRandom(seededRandom(7)).rng,
    });
    const rack = state.racks[state.turn] ?? [];
    const placements: Placement[] = rack
      .slice(0, 3)
      .map((tile, i) => ({ row, col: col + i, tile, ...(tile === "?" ? { letter: "a" } : {}) }));
    const server = preview(
      state,
      state.turn,
      { type: "play", placements },
      {
        dictionary: { id: "enable", version: 1, has: (w) => set.has(w) },
      },
    );
    const local = previewViewPlay(view(state, state.turn), placements, (w) => browser.has(w));
    expect(local).toStrictEqual(server);
  });
});
