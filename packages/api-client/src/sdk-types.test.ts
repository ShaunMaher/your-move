/**
 * The 02 §7.4 / 05 type-level test: the SDK's client-facing schemas the server registers as they
 * are come out of the generated client structurally identical, so a game client can use either.
 * Each pair must be assignable both ways; `pnpm typecheck` fails otherwise (A2 review P-3). The
 * SDK's schemas appear inline in the document, so each is checked where a route registers it.
 */
import type {
  GameEnvelope,
  gamePlayerSchema,
  listSummarySchema,
  SubmitResult,
  textSchema,
} from "@your-move/sdk";
import type { z } from "@your-move/sdk/schema";
import { describe, expect, it } from "vitest";

import type { components } from "./schema.js";

type Schemas = components["schemas"];

/**
 * A type as JSON carries it: an optional property is either absent or has a value, so Zod's
 * `?: T | undefined` and the generated `?: T` are the same on the wire (`exactOptionalPropertyTypes`
 * tells them apart). Optional and required stay distinct.
 */
type Wire<T> = T extends readonly (infer U)[]
  ? Wire<U>[]
  : T extends object
    ? { [K in keyof T]: Wire<Exclude<T[K], undefined>> }
    : T;

/** `true` only if each type is assignable to the other, as JSON carries them. */
type Mutual<A, B> = [Wire<A>] extends [Wire<B>]
  ? [Wire<B>] extends [Wire<A>]
    ? true
    : false
  : false;

/** Compiles only for `true`. */
function assertMutual<T extends true>(value: T): T {
  return value;
}

// The schemas' own types: `Text` and `ListSummary` as modules see them are readonly views of these.
type Text = z.infer<typeof textSchema>;
type ListSummary = z.infer<typeof listSummarySchema>;
type GamePlayer = z.infer<typeof gamePlayerSchema>;
type SubmitOk = Extract<SubmitResult, { ok: true }>;

describe("the SDK's API types and the generated client's (02 §7.4)", () => {
  it("are mutually assignable wherever a route registers an SDK schema", () => {
    const checks = [
      // GameEnvelope: the game read, every transition, creating and moving.
      assertMutual<Mutual<Schemas["GameWithView"]["game"], GameEnvelope>>(true),
      assertMutual<Mutual<Schemas["CreatedGame"]["game"], GameEnvelope>>(true),
      assertMutual<Mutual<Schemas["ActionResult"]["game"], GameEnvelope>>(true),
      // The shell's submit result: the game and the view, always present, as the routes answer.
      assertMutual<Mutual<Schemas["GameWithView"], Omit<SubmitOk, "ok">>>(true),
      assertMutual<
        Mutual<Schemas["ActionResult"], Omit<SubmitOk, "ok"> & { record: unknown; describe: Text }>
      >(true),
      // The envelope's players, as the game list shows them.
      assertMutual<Mutual<Schemas["GameSummary"]["players"][number], GamePlayer>>(true),
      // ListSummary and Text.
      assertMutual<Mutual<Schemas["GameSummary"]["summary"], ListSummary>>(true),
      assertMutual<Mutual<Schemas["ActionResult"]["describe"], Text>>(true),
      assertMutual<Mutual<Schemas["HistoryItem"]["describe"], Text>>(true),
      assertMutual<Mutual<NonNullable<Schemas["GameSummary"]["lastAction"]>["describe"], Text>>(
        true,
      ),
    ];
    expect(checks.every(Boolean)).toBe(true);
  });

  it("fail to compile when a pair drifts: the check itself is checked at typecheck", () => {
    // If the check stopped rejecting a drifted pair, this directive would be unused and tsc fails.
    // @ts-expect-error optional against required is drift
    assertMutual<Mutual<{ a?: number }, { a: number }>>(true);
    expect(true).toBe(true);
  });

  it("are not trivially so: optionality and readonly arrays are told apart", () => {
    const caught = [
      assertMutual<Mutual<{ a?: unknown }, { a: unknown }> extends false ? true : never>(true),
      assertMutual<Mutual<{ a?: number }, { a: number }> extends false ? true : never>(true),
      assertMutual<Mutual<{ a: string[] }, { a: number[] }> extends false ? true : never>(true),
      assertMutual<Mutual<{ a?: number }, { a?: number | undefined }>>(true),
    ];
    expect(caught.every(Boolean)).toBe(true);
  });
});
