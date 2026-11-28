/**
 * `pnpm ops:usage [file] [--players N] [--json]`: reads the Node server's JSON request log lines
 * (docs/spec/09-operations.md §5) from a file or stdin and prints requests per route and
 * per-move, per-game and per-player-per-day estimates (docs/spec/10-roadmap.md, Workers cost
 * model). Read-only: it logs nothing and fetches nothing.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import { buildReport, formatReport, parseLog } from "../usage/report.js";
import { fail, run } from "./cli.js";

run("ops:usage", async () => {
  const { values, positionals } = parseArgs({
    options: { players: { type: "string" }, json: { type: "boolean" } },
    allowPositionals: true,
  });
  const players = values.players === undefined ? null : Number(values.players);
  if (players !== null && !(Number.isInteger(players) && players > 0)) {
    fail("ops:usage", ["--players must be a positive integer"]);
  }
  const [file] = positionals;
  const input = file === undefined ? process.stdin : createReadStream(file, "utf8");
  const lines: string[] = [];
  for await (const line of createInterface({ input })) lines.push(line);
  const report = buildReport(parseLog(lines), { players });
  process.stdout.write(
    values.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
  );
});
