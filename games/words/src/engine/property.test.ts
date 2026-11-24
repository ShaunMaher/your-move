/**
 * Property tests (10 M1, words §10.7), under every bundled ruleset with the real built-in word
 * list: thousands of random legal games played by the kit's bot with a seeded `RandomSource`.
 * After every transition the tiles are conserved (bag + racks + board = the ruleset's tiles), and
 * each finished game replays from its recorded draws to exactly the same state.
 */
import { isGameError, recordRandom, replayRandom, type Resources, type Seat } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { beforeAll, describe, expect, it } from "vitest";

import { conserved, options, realDictionary, ruleset } from "../test-support.js";
import { wordsV1 as words } from "./definition.js";
import { RULESETS } from "./rulesets/index.js";
import type { Action } from "./schemas.js";
import type { State } from "./state.js";

/** Games per ruleset: 1000 each, so thousands across the bundled rulesets. */
const GAMES = 1000;

interface Entry {
  readonly seat: Seat;
  readonly kind: "action" | "resign" | "timeout";
  readonly action?: Action;
  readonly draws: readonly number[];
}

let res: Resources;
beforeAll(async () => {
  res = (await realDictionary()).resources;
});

describe.each([...RULESETS.keys()])("random games under the %s ruleset", (id) => {
  it(`conserves tiles, keeps every invariant and replays (${String(GAMES)} games)`, () => {
    const rules = ruleset(id);
    const opts = options(id);
    const limit = words.test.maxActions(opts, 2);
    const ends = new Map<string, number>();
    for (let game = 0; game < GAMES; game += 1) {
      const rng = seededRandom(game);
      const setupDraws = recordRandom(seededRandom(game ^ 0x5bd1e995));
      let state: State = words.setup({ options: opts, seats: 2, rng: setupDraws.rng });
      const log: Entry[] = [];
      expect(conserved(state, rules)).toBe(true);
      for (let step = 0; words.result(state) === null; step += 1) {
        expect(step).toBeLessThan(limit);
        const [seat] = words.toAct(state);
        if (seat === undefined) throw new Error("no seat to act in a game in progress");
        const recording = recordRandom(seededRandom(rng.nextInt(2 ** 32)));
        // Now and then a seat leaves, so every ending is reached.
        const leave = rng.nextInt(400);
        let next: { state: State; record: unknown };
        if (leave === 0) {
          next = words.onResign(state, seat, recording.rng, "resign");
          log.push({ seat, kind: "resign", draws: recording.draws });
        } else if (leave === 1) {
          next = words.onTimeout(state, seat, recording.rng);
          log.push({ seat, kind: "timeout", draws: recording.draws });
        } else {
          const action = words.test.randomAction(state, seat, rng, res);
          expect(isGameError(words.validate(state, seat, action, res))).toBe(false);
          next = words.apply(state, seat, action, recording.rng);
          log.push({ seat, kind: "action", action, draws: recording.draws });
        }
        expect(words.recordSchema.safeParse(next.record).success).toBe(true);
        state = next.state;
        if (!conserved(state, rules))
          throw new Error(`tiles not conserved: ${id} game ${String(game)}`);
        for (const held of state.racks) expect(held.length).toBeLessThanOrEqual(rules.rackSize);
        if (state.finished === null) {
          expect(state.scorelessStreak).toBeLessThan(rules.scorelessTurnLimit);
          // A rack is short only once the bag is empty.
          if (state.bag.length > 0)
            for (const held of state.racks) expect(held).toHaveLength(rules.rackSize);
        }
      }
      const reason = words.result(state)?.endReason ?? "";
      ends.set(reason, (ends.get(reason) ?? 0) + 1);

      // Replay with the recorded draws and no resources reproduces the state (02 §5).
      const draws = replayRandom(setupDraws.draws);
      let replayed = words.setup({ options: opts, seats: 2, rng: draws });
      for (const entry of log) {
        const r = replayRandom(entry.draws);
        replayed =
          entry.kind === "action" && entry.action !== undefined
            ? words.apply(replayed, entry.seat, entry.action, r).state
            : entry.kind === "timeout"
              ? words.onTimeout(replayed, entry.seat, r).state
              : words.onResign(replayed, entry.seat, r, "resign").state;
        expect(r.remaining()).toBe(0);
      }
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(state));
    }
    // Every ending was reached (words §5). (Bingos are too rare for the bot; board.test.ts has them.)
    for (const reason of ["out", "scoreless", "resign", "timeout"]) {
      expect(ends.get(reason) ?? 0, reason).toBeGreaterThan(0);
    }
  }, 300_000);
});
