/**
 * Usage report from the Node server's request log (09 §5, roadmap "Workers cost model"): requests
 * per route and an estimate of requests per move, per game and per player per day. Pure and
 * streaming: lines are folded into an aggregator whose memory grows with the number of distinct
 * routes, not lines. It logs nothing. The log carries no game id or user, so every figure is
 * derived from route counts and says so.
 */

/**
 * Cloudflare Workers Free plan: requests a day. Check Cloudflare's current pricing page before
 * relying on it; the figure changes and this script never fetches it.
 */
export const FREE_PLAN_REQUESTS_PER_DAY = 100_000;

/** The route the Node server logs for static assets and the SPA fallback. */
const STATIC_ROUTE = "/*";
/** The container health probe's routes: Docker only, never a Workers request. */
const HEALTH_ROUTES: ReadonlySet<string> = new Set(["/api/health", "/api/v1/health"]);
const UNMATCHED = "(unmatched)";
const OTHER_ROUTE = "(other)";
const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
/** Route patterns only: no query string, whitespace or control characters (09 §5). */
const ROUTE_SHAPE = /^\/[A-Za-z0-9/:_*.-]*$/;
const MS_PER_DAY = 86_400_000;

const ACTIONS = "/api/v1/games/:id/actions";
const CREATE = "/api/v1/games";
const REMATCH = "/api/v1/games/:id/rematch";
const RESIGN = "/api/v1/games/:id/resign";

interface LogLine {
  readonly msg?: unknown;
  readonly method?: unknown;
  readonly route?: unknown;
  readonly status?: unknown;
  readonly time?: unknown;
}

export interface RouteCount {
  readonly method: string;
  readonly route: string;
  readonly count: number;
}

export interface UsageReport {
  readonly totalRequests: number;
  readonly malformedLines: number;
  readonly ignoredLines: number;
  readonly routes: readonly RouteCount[];
  /** The container health probe (`/api/health`): not a Workers request. */
  readonly healthChecks: number;
  /** HEAD and OPTIONS requests outside the health probe, reported apart. */
  readonly headRequests: number;
  readonly optionsRequests: number;
  /** Hits on the static route, assumed free of charge on Workers. */
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

const ok = (status: number): boolean => status >= 200 && status < 300;
const divide = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Strips control characters, so a hostile log line can't drive the terminal. */
const printable = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- the point is to match control characters
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

/** Folds request log lines into counts. Feed it lines, then call `report`. */
export class UsageAggregator {
  private readonly counts = new Map<string, RouteCount>();
  private total = 0;
  private malformed = 0;
  private ignored = 0;
  private health = 0;
  private head = 0;
  private options = 0;
  private statics = 0;
  private moves = 0;
  private created = 0;
  private resigns = 0;
  private first = Infinity;
  private last = -Infinity;

  /**
   * Adds one line. Whatever precedes the first `{` is dropped, which covers the `app-1  | ` prefix
   * of `docker compose logs` and the timestamp of `docker logs --timestamps`.
   */
  add(raw: string): void {
    if (raw.trim() === "") return;
    const start = raw.indexOf("{");
    let value: unknown;
    try {
      value = start < 0 ? undefined : JSON.parse(raw.slice(start));
    } catch {
      value = undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.malformed += 1;
      return;
    }
    const line = value as LogLine;
    if (
      line.msg !== "request" ||
      typeof line.method !== "string" ||
      !METHODS.has(line.method) ||
      typeof line.route !== "string" ||
      typeof line.status !== "number"
    ) {
      this.ignored += 1;
      return;
    }
    const { method, status } = line;
    const route =
      line.route === UNMATCHED || ROUTE_SHAPE.test(line.route) ? line.route : OTHER_ROUTE;
    this.total += 1;
    const key = `${method} ${route}`;
    const known = this.counts.get(key);
    this.counts.set(key, { method, route, count: (known?.count ?? 0) + 1 });
    const at = typeof line.time === "string" ? Date.parse(line.time) : Number.NaN;
    if (!Number.isNaN(at)) {
      this.first = Math.min(this.first, at);
      this.last = Math.max(this.last, at);
    }
    if (HEALTH_ROUTES.has(route)) this.health += 1;
    else if (method === "HEAD") this.head += 1;
    else if (method === "OPTIONS") this.options += 1;
    else if (route === STATIC_ROUTE) this.statics += 1;
    if (method !== "POST" || !ok(status)) return;
    if (route === ACTIONS) this.moves += 1;
    else if (route === CREATE || route === REMATCH) this.created += 1;
    else if (route === RESIGN) this.resigns += 1;
  }

  /** `players` is the number of active players, which the log cannot tell; null leaves it out. */
  report(options: { readonly players?: number | null } = {}): UsageReport {
    const workerRequests = this.total - this.health - this.head - this.options - this.statics;
    const spanDays = this.last >= this.first ? (this.last - this.first) / MS_PER_DAY : null;
    const days = spanDays === null ? null : Math.max(spanDays, 1);
    const players = options.players ?? null;
    const requestsPerDay = days === null ? null : workerRequests / days;
    return {
      totalRequests: this.total,
      malformedLines: this.malformed,
      ignoredLines: this.ignored,
      routes: [...this.counts.values()].sort(
        (a, b) =>
          b.count - a.count || `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`),
      ),
      healthChecks: this.health,
      headRequests: this.head,
      optionsRequests: this.options,
      staticRequests: this.statics,
      workerRequests,
      moves: this.moves,
      gamesCreated: this.created,
      resigns: this.resigns,
      days,
      spanDays,
      players,
      requestsPerDay,
      requestsPerMove: divide(workerRequests, this.moves),
      requestsPerGame: divide(workerRequests, this.created),
      requestsPerPlayerPerDay:
        requestsPerDay === null || players === null ? null : divide(requestsPerDay, players),
      freePlanLimit: FREE_PLAN_REQUESTS_PER_DAY,
      freePlanShare: requestsPerDay === null ? null : requestsPerDay / FREE_PLAN_REQUESTS_PER_DAY,
    };
  }
}

/** Reads every line of a (possibly huge) source without holding them. */
export async function aggregate(
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<UsageAggregator> {
  const aggregator = new UsageAggregator();
  for await (const line of lines) aggregator.add(line);
  return aggregator;
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
    `Health checks (container probe; not on Workers, not counted below): ${String(report.healthChecks)}`,
    `HEAD (not counted below): ${String(report.headRequests)}; OPTIONS (not counted below): ${String(report.optionsRequests)}`,
    `Static (route "${STATIC_ROUTE}", assumed free of charge, not counted below): ${String(report.staticRequests)}`,
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
    "  - Per player per day assumes every player was active every day; restart gaps or log rotation",
    "    inside the span count as zero traffic.",
    "  - Health checks (/api/health, /api/v1/health) are the Docker container probe and never reach",
    "    Workers, so they are left out of every figure above. HEAD and OPTIONS requests are reported",
    "    apart and also left out; a CORS preflight would be a Worker request, so this may understate.",
    "  - A Node `/*` hit is a proxy for a static asset (it includes the SPA fallback). Static assets",
    "    are assumed free of charge: verify against Cloudflare's Workers Static Assets billing docs.",
    "    Routes configured with run_worker_first do invoke the Worker and would count.",
  );
  return `${out.map(printable).join("\n")}\n`;
}
