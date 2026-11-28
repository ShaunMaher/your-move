/**
 * `pnpm ops:usage [file] [--players N] [--json]`: reads the Node server's JSON request log lines
 * (docs/spec/09-operations.md §5) from a file or stdin and prints requests per route and
 * per-move, per-game and per-player-per-day estimates (docs/spec/10-roadmap.md, Workers cost
 * model). Read-only: it logs nothing and fetches nothing.
 */
import { parseUsageArgs, linesFrom } from "../usage/cli.js";
import { aggregate, formatReport } from "../usage/report.js";
import { run } from "./cli.js";

run("ops:usage", async () => {
  const args = parseUsageArgs(process.argv.slice(2));
  const report = (await aggregate(linesFrom(args.file, process.stdin))).report({
    players: args.players,
  });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
});
