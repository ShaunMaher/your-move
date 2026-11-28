import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

export interface UsageArgs {
  /** The log file, or null to read stdin. */
  readonly file: string | null;
  readonly players: number | null;
  readonly json: boolean;
}

/** Parses `pnpm ops:usage [file] [--players N] [--json]`; throws a one-line message on bad input. */
export function parseUsageArgs(argv: readonly string[]): UsageArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { players: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  if (positionals.length > 1) throw new Error("expected at most one log file");
  let players: number | null = null;
  if (values.players !== undefined) {
    players = /^[0-9]+$/.test(values.players) ? Number(values.players) : Number.NaN;
    if (!Number.isInteger(players) || players < 1) {
      throw new Error("--players must be a positive integer");
    }
  }
  return { file: positionals[0] ?? null, players, json: values.json === true };
}

/** The lines of the file, or of `stdin` when there is none (CRLF and LF both split lines). */
export function linesFrom(
  file: string | null,
  stdin: NodeJS.ReadableStream,
): AsyncIterable<string> {
  const input = file === null ? stdin : createReadStream(file, "utf8");
  return createInterface({ input, crlfDelay: Infinity });
}
