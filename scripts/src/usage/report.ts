/**
 * Usage report from the Node server's request log (09 §5, roadmap "Workers cost model"): requests
 * per route and an estimate of requests per move, per game and per player per day. Pure: it reads
 * log lines it is given and logs nothing. The log carries no game id or user, so every figure is
 * derived from route counts and says so.
 */

/**
 * Cloudflare Workers Free plan: requests a day. Check Cloudflare's current pricing page before
 * relying on it; the figure changes and this script never fetches it.
 */
export const FREE_PLAN_REQUESTS_PER_DAY = 100_000;

/** The route the Node server logs for static assets (Workers serves these without a request charge). */
const STATIC_ROUTE = "/*";

const MS_PER_DAY = 86_400_000;

interface RequestEntry {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  /** Epoch milliseconds, or null when the line had no valid `time`. */
  readonly at: number | null;
}

export interface ParsedLog {
  readonly requests: readonly RequestEntry[];
  /** Lines that were not JSON objects (blank lines are not counted). */
  readonly malformed: number;
  /** JSON lines that were not `request` lines, or lacked a usable method, route or status. */
  readonly ignored: number;
}

interface LogLine {
  readonly msg?: unknown;
  readonly method?: unknown;
  readonly route?: unknown;
  readonly status?: unknown;
  readonly time?: unknown;
}

/**
 * Reads log lines. `docker compose logs` prefixes each line with `app-1  | `, so everything before
 * the first `{` is dropped.
 */
export function parseLog(lines: Iterable<string>): ParsedLog {
  const requests: RequestEntry[] = [];
  let malformed = 0;
  let ignored = 0;
  for (const raw of lines) {
    const start = raw.indexOf("{");
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = start < 0 ? undefined : JSON.parse(raw.slice(start));
    } catch {
      value = undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      malformed += 1;
      continue;
    }
    const line = value as LogLine;
    if (
      line.msg !== "request" ||
      typeof line.method !== "string" ||
      typeof line.route !== "string" ||
      typeof line.status !== "number"
    ) {
      ignored += 1;
      continue;
    }
    const at = typeof line.time === "string" ? Date.parse(line.time) : Number.NaN;
    requests.push({
      method: line.method,
      route: line.route,
      status: line.status,
      at: Number.isNaN(at) ? null : at,
    });
  }
  return { requests, malformed, ignored };
}

interface RouteCount {
  readonly method: string;
  readonly route: string;
  readonly count: number;
}

export interface UsageReport {
  readonly totalRequests: number;
  readonly malformedLines: number;
  readonly ignoredLines: number;
  readonly routes: readonly RouteCount[];
  /** Requests on the static route, which a Workers deployment would not run code for. */
  readonly staticRequests: number;
  /** Everything else: what would count against the Workers request limit. */
  readonly workerRequests: number;
  readonly moves: number;
  /** Successful game creations, including rematches. */
  readonly gamesCreated: number;
  readonly resigns: number;
  /** Days between the first and last timestamp, floored at one; null when no line had a time. */
  readonly days: number | null;
  readonly spanDays: number | null;
  readonly players: number | null;
  readonly requestsPerDay: number | null;
  readonly requestsPerMove: number | null;
  readonly requestsPerGame: number | null;
  readonly requestsPerPlayerPerDay: number | null;
  readonly freePlanLimit: number;
  /** `requestsPerDay` as a share of the Free plan's daily limit. */
  readonly freePlanShare: number | null;
}

const ACTIONS = "/api/v1/games/:id/actions";
const CREATE = "/api/v1/games";
const REMATCH = "/api/v1/games/:id/rematch";
const RESIGN = "/api/v1/games/:id/resign";

const ok = (status: number): boolean => status >= 200 && status < 300;
const divide = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** `players` is the number of active players, which the log cannot tell; null leaves that figure out. */
export function buildReport(
  log: ParsedLog,
  options: { readonly players?: number | null } = {},
): UsageReport {
  const counts = new Map<string, RouteCount>();
  let moves = 0;
  let gamesCreated = 0;
  let resigns = 0;
  let staticRequests = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const { method, route, status, at } of log.requests) {
    const key = `${method} ${route}`;
    counts.set(key, { method, route, count: (counts.get(key)?.count ?? 0) + 1 });
    if (route === STATIC_ROUTE) staticRequests += 1;
    if (at !== null) {
      first = Math.min(first, at);
      last = Math.max(last, at);
    }
    if (method !== "POST" || !ok(status)) continue;
    if (route === ACTIONS) moves += 1;
    else if (route === CREATE || route === REMATCH) gamesCreated += 1;
    else if (route === RESIGN) resigns += 1;
  }
  const total = log.requests.length;
  const workerRequests = total - staticRequests;
  const spanDays = last >= first ? (last - first) / MS_PER_DAY : null;
  const days = spanDays === null ? null : Math.max(spanDays, 1);
  const players = options.players ?? null;
  const requestsPerDay = days === null ? null : workerRequests / days;
  return {
    totalRequests: total,
    malformedLines: log.malformed,
    ignoredLines: log.ignored,
    routes: [...counts.values()].sort(
      (a, b) =>
        b.count - a.count || `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`),
    ),
    staticRequests,
    workerRequests,
    moves,
    gamesCreated,
    resigns,
    days,
    spanDays,
    players,
    requestsPerDay,
    requestsPerMove: divide(workerRequests, moves),
    requestsPerGame: divide(workerRequests, gamesCreated),
    requestsPerPlayerPerDay:
      requestsPerDay === null || players === null ? null : divide(requestsPerDay, players),
    freePlanLimit: FREE_PLAN_REQUESTS_PER_DAY,
    freePlanShare: requestsPerDay === null ? null : requestsPerDay / FREE_PLAN_REQUESTS_PER_DAY,
  };
}

const num = (value: number | null, digits = 1): string =>
  value === null ? "n/a" : value.toFixed(digits);

/** The text report, with the assumptions behind each figure. */
export function formatReport(report: UsageReport): string {
  const out: string[] = [];
  out.push("Requests per route (METHOD route: count)");
  const width = Math.max(0, ...report.routes.map((r) => String(r.count).length));
  for (const r of report.routes) {
    out.push(`  ${String(r.count).padStart(width)}  ${r.method} ${r.route}`);
  }
  if (report.routes.length === 0) out.push("  (no request lines)");
  out.push(
    "",
    `Lines: ${String(report.totalRequests)} requests, ${String(report.ignoredLines)} other log lines, ${String(report.malformedLines)} malformed`,
    `Static (route "${STATIC_ROUTE}", not counted below): ${String(report.staticRequests)}`,
    `Worker-run requests: ${String(report.workerRequests)}`,
    `Period: ${report.spanDays === null ? "unknown (no timestamps)" : `${report.spanDays.toFixed(2)} days of log, figures use ${num(report.days, 2)}`}`,
    "",
    "Estimates (worker-run requests)",
    `  moves (successful POST ${ACTIONS}): ${String(report.moves)}`,
    `  games created (successful POST ${CREATE} or ${REMATCH}): ${String(report.gamesCreated)}`,
    `  requests per day: ${num(report.requestsPerDay, 0)}`,
    `  requests per move: ${num(report.requestsPerMove)}${report.moves === 0 ? " (no moves in the log)" : ""}`,
    `  requests per game: ${num(report.requestsPerGame)}${report.gamesCreated === 0 ? " (no games created in the log)" : ""}`,
    `  requests per player per day: ${num(report.requestsPerPlayerPerDay)}${report.players === null ? " (pass --players N, the number of active players; the log has no user)" : ""}`,
    "",
    `Free plan: ${num(report.requestsPerDay, 0)} requests/day is ${report.freePlanShare === null ? "n/a" : `${(report.freePlanShare * 100).toFixed(1)}%`} of ${String(report.freePlanLimit)} (check Cloudflare's current pricing page)`,
    "",
    "Assumptions",
    "  - The log has no game id or user, so everything comes from route counts.",
    "  - A game is created by a successful POST to the games route or a rematch; a game that was",
    "    created before the log starts, or is still running at its end, skews per-game figures.",
    "  - Finished games cannot be counted: no route marks a game ending (moves and resigns can end one).",
    `    Successful resigns in the log: ${String(report.resigns)}.`,
    "  - Requests per move and per game divide ALL worker-run requests (polling, history, sign-in,",
    "    push) by that count, so they include traffic that isn't the move itself.",
    "  - The period is first to last timestamp, at least one day; a partial day understates a rate.",
    "  - Static assets (route /*) are excluded: Workers serves them without a request charge.",
  );
  return `${out.join("\n")}\n`;
}
