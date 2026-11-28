import { describe, expect, it } from "vitest";

import { buildReport, formatReport, FREE_PLAN_REQUESTS_PER_DAY, parseLog } from "./report.js";

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
];

describe("parseLog", () => {
  it("keeps request lines and counts malformed and other lines apart", () => {
    const parsed = parseLog([
      line("/api/health"),
      "",
      "not json at all",
      "[1,2]",
      "{broken",
      JSON.stringify({ level: "info", msg: "listening", time: day1 }),
      JSON.stringify({ level: "warn", msg: "request", route: "/x" }),
      JSON.stringify({ msg: "request", method: "GET", route: "/x", status: "200" }),
    ]);
    expect(parsed.requests).toHaveLength(1);
    expect(parsed.malformed).toBe(3);
    expect(parsed.ignored).toBe(3);
  });

  it("strips the docker compose prefix", () => {
    const parsed = parseLog([`app-1  | ${line("/api/health")}`]);
    expect(parsed.requests.map((r) => r.route)).toEqual(["/api/health"]);
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
    expect(parseLog([noTime, badTime]).requests.map((r) => r.at)).toEqual([null, null]);
  });
});

describe("buildReport", () => {
  const report = buildReport(parseLog(FIXTURE), { players: 2 });

  it("sorts routes by count then name", () => {
    expect(report.routes.map((r) => `${String(r.count)} ${r.method} ${r.route}`)).toEqual([
      "3 POST /api/v1/games/:id/actions",
      "2 GET /*",
      "2 GET /api/v1/games/:id",
      "1 POST /api/v1/games",
      "1 POST /api/v1/games/:id/rematch",
      "1 POST /api/v1/games/:id/resign",
    ]);
  });

  it("counts only successful moves and creations", () => {
    expect(report.moves).toBe(2);
    expect(report.gamesCreated).toBe(2);
    expect(report.resigns).toBe(1);
  });

  it("excludes static requests from the worker figures", () => {
    expect(report.staticRequests).toBe(2);
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
    const short = buildReport(parseLog([line("/api/health"), line("/api/health")]));
    expect(short.days).toBe(1);
    expect(short.requestsPerDay).toBe(2);
  });

  it("says n/a rather than inventing figures", () => {
    const empty = buildReport(parseLog([]));
    expect(empty.requestsPerMove).toBeNull();
    expect(empty.requestsPerDay).toBeNull();
    expect(empty.freePlanShare).toBeNull();
    const text = formatReport(empty);
    expect(text).toContain("(no request lines)");
    expect(text).toContain("requests per move: n/a (no moves in the log)");
    expect(text).toContain("Free plan: n/a requests/day is n/a");
    const noPlayers = formatReport(buildReport(parseLog(FIXTURE)));
    expect(noPlayers).toContain("requests per player per day: n/a (pass --players N");
  });
});

describe("formatReport", () => {
  it("prints the routes, the Free plan line and the assumptions", () => {
    const text = formatReport(buildReport(parseLog(FIXTURE), { players: 2 }));
    expect(text).toContain("3  POST /api/v1/games/:id/actions");
    expect(text).toContain("requests per move: 4.0");
    expect(text).toContain("Free plan: 4 requests/day is 0.0% of 100000");
    expect(text).toContain("Assumptions");
  });
});
