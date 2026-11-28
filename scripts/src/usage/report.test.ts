import { describe, expect, it } from "vitest";

import { aggregate, formatReport, FREE_PLAN_REQUESTS_PER_DAY, UsageAggregator } from "./report.js";

const line = (route: string, method = "GET", status = 200, time = "2030-01-01T00:00:00.000Z") =>
  JSON.stringify({
    level: "info",
    msg: "request",
    requestId: "r",
    method,
    route,
    status,
    durationMs: 3,
    time,
  });

const day1 = "2030-01-01T00:00:00.000Z";
const day3 = "2030-01-03T00:00:00.000Z";

const FIXTURE = [
  line("/api/v1/games/:id/actions", "POST", 200, day1),
  line("/api/v1/games/:id/actions", "POST", 200, day1),
  line("/api/v1/games/:id/actions", "POST", 409, day1),
  line("/api/v1/games", "POST", 201, day1),
  line("/api/v1/games/:id/rematch", "POST", 201, day1),
  line("/api/v1/games/:id/resign", "POST", 204, day1),
  line("/api/v1/games/:id", "GET", 200, day3),
  line("/api/v1/games/:id", "GET", 200, day3),
  line("/*", "GET", 200, day3),
  line("/*", "GET", 200, day3),
  line("/api/health", "GET", 200, day3),
  line("/api/health", "HEAD", 200, day3),
  line("/api/v1/games/:id", "HEAD", 200, day3),
  line("/api/v1/me", "OPTIONS", 204, day3),
];

function build(lines: readonly string[], players: number | null = null) {
  const aggregator = new UsageAggregator();
  for (const l of lines) aggregator.add(l);
  return aggregator.report({ players });
}

describe("UsageAggregator.add", () => {
  it("keeps request lines and counts malformed and other lines apart", () => {
    const report = build([
      line("/api/v1/me"),
      "",
      "   ",
      "not json at all",
      "[1,2]",
      "{broken",
      JSON.stringify({ level: "info", msg: "listening", time: day1 }),
      JSON.stringify({ level: "warn", msg: "request", route: "/x" }),
      JSON.stringify({ msg: "request", method: "GET", route: "/x", status: "200" }),
      JSON.stringify({ msg: "request", method: "BREW", route: "/x", status: 200 }),
    ]);
    expect(report.totalRequests).toBe(1);
    expect(report.malformedLines).toBe(3);
    expect(report.ignoredLines).toBe(4);
  });

  it("strips the docker compose prefix, the --timestamps prefix and CRLF", () => {
    const report = build([
      `app-1  | ${line("/api/v1/me")}`,
      `2030-01-01T00:00:00.123456789Z ${line("/api/v1/me")}`,
      `${line("/api/v1/me")}\r`,
    ]);
    expect(report.routes).toEqual([{ method: "GET", route: "/api/v1/me", count: 3 }]);
  });

  it("parses the bare capture format (time, method, route, status, durationMs, msg)", () => {
    const capture = JSON.stringify({
      time: day1,
      method: "POST",
      route: "/api/v1/games/:id/actions",
      status: 200,
      durationMs: 4,
      msg: "request",
    });
    const report = build([capture]);
    expect(report.moves).toBe(1);
    expect(report.spanDays).toBe(0);
  });

  it("tolerates a missing or invalid time", () => {
    const noTime = JSON.stringify({ msg: "request", method: "GET", route: "/a", status: 200 });
    const badTime = JSON.stringify({
      msg: "request",
      method: "GET",
      route: "/a",
      status: 200,
      time: "x",
    });
    const report = build([noTime, badTime]);
    expect(report.totalRequests).toBe(2);
    expect(report.days).toBeNull();
  });

  it("counts a route that is not a pattern under (other), query strings included", () => {
    const report = build([
      line("/api/v1/email/unsubscribe?t=secret"),
      line("/api/v1/x\u001b[31m"),
      line("not-a-path"),
      line("(unmatched)"),
    ]);
    expect(report.routes.map((r) => `${String(r.count)} ${r.route}`).sort()).toEqual([
      "1 (unmatched)",
      "3 (other)",
    ]);
  });

  it("never prints a query string, as text or JSON", () => {
    const report = build([line("/api/v1/email/unsubscribe?t=secret")]);
    expect(formatReport(report)).not.toContain("secret");
    expect(JSON.stringify(report, null, 2)).not.toContain("secret");
  });
});

describe("report", () => {
  const report = build(FIXTURE, 2);

  it("sorts routes by count then name", () => {
    expect(
      report.routes.slice(0, 4).map((r) => `${String(r.count)} ${r.method} ${r.route}`),
    ).toEqual([
      "3 POST /api/v1/games/:id/actions",
      "2 GET /*",
      "2 GET /api/v1/games/:id",
      "1 GET /api/health",
    ]);
  });

  it("counts only successful moves and creations", () => {
    expect(report.moves).toBe(2);
    expect(report.gamesCreated).toBe(2);
    expect(report.resigns).toBe(1);
  });

  it("keeps health checks, HEAD, OPTIONS and static hits out of the worker figures", () => {
    expect(report.healthChecks).toBe(2);
    expect(report.headRequests).toBe(1);
    expect(report.optionsRequests).toBe(1);
    expect(report.staticRequests).toBe(2);
    expect(report.totalRequests).toBe(14);
    expect(report.workerRequests).toBe(8);
    expect(report.requestsPerMove).toBe(4);
    expect(report.requestsPerGame).toBe(4);
  });

  it("derives per-day figures from the log span", () => {
    expect(report.spanDays).toBe(2);
    expect(report.requestsPerDay).toBe(4);
    expect(report.requestsPerPlayerPerDay).toBe(2);
    expect(report.freePlanShare).toBeCloseTo(4 / FREE_PLAN_REQUESTS_PER_DAY);
  });

  it("floors the period at one day", () => {
    const short = build([line("/api/v1/me"), line("/api/v1/me")]);
    expect(short.days).toBe(1);
    expect(short.requestsPerDay).toBe(2);
  });

  it("says n/a rather than inventing figures", () => {
    const empty = build([]);
    expect(empty.requestsPerMove).toBeNull();
    expect(empty.requestsPerDay).toBeNull();
    expect(empty.freePlanShare).toBeNull();
    const text = formatReport(empty);
    expect(text).toContain("(no request lines)");
    expect(text).toContain("requests per move: n/a (no moves in the log)");
    expect(text).toContain("Free plan: n/a requests/day is n/a");
    expect(formatReport(build(FIXTURE))).toContain(
      "requests per player per day: n/a (pass --players N",
    );
  });
});

describe("formatReport", () => {
  it("prints the routes, health line, Free plan line and assumptions", () => {
    const text = formatReport(build(FIXTURE, 2));
    expect(text).toContain("3  POST /api/v1/games/:id/actions");
    expect(text).toContain("Health checks (container probe; not on Workers, not counted below): 2");
    expect(text).toContain("HEAD (not counted below): 1; OPTIONS (not counted below): 1");
    expect(text).toContain("requests per move: 4.0");
    expect(text).toContain("Free plan: 4 requests/day is 0.0% of 100000");
    expect(text).toContain("every player was active every day");
    expect(text).toContain("run_worker_first");
  });
});

describe("aggregate", () => {
  it("streams 200k lines within budget, holding counts rather than lines", async () => {
    const routes = ["/api/v1/me", "/api/v1/games/:id", "/api/health", "/*"];
    function* lines(): Generator<string> {
      for (let i = 0; i < 200_000; i += 1) {
        yield line(routes[i % routes.length] ?? "/*", "GET", 200, day1);
      }
    }
    const started = performance.now();
    const aggregator = await aggregate(lines());
    const elapsed = performance.now() - started;
    const report = aggregator.report();
    expect(report.totalRequests).toBe(200_000);
    expect(report.routes).toHaveLength(4);
    expect(elapsed).toBeLessThan(5000);
  });

  it("accepts an async iterable", async () => {
    async function* lines(): AsyncGenerator<string> {
      await Promise.resolve();
      yield line("/api/v1/me");
    }
    expect((await aggregate(lines())).report().totalRequests).toBe(1);
  });
});
