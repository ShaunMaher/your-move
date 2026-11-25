/**
 * The API contract suite (docs/spec/05-api.md §Versioning, 11 §4): written against
 * `@your-move/api-client` and run unchanged against every runtime build.
 */
import { readFileSync } from "node:fs";

import { createApiClient } from "@your-move/api-client";
import {
  deriveSubkeys,
  emailId as emailIdOf,
  normaliseAddress,
  type Repositories,
  securityHeaders,
} from "@your-move/server";
import { createSession, unsubscribeToken } from "@your-move/server/testing";
import { ClientConfigSchema, ErrorResponseSchema } from "@your-move/shared";
import { describe, expect, it } from "vitest";

import { CONTRACT_SECRETS, CONTRACT_VARS } from "./env.js";

export interface Target {
  /** Sends a request to the runtime under test. */
  fetch(request: Request): Promise<Response>;
  /**
   * The runtime's own database, for seeding signed-in players: the contract configuration sends
   * no email, so no sign-in code can be read.
   */
  repos(): Promise<Repositories>;
}

/** Every runtime is configured with an https PUBLIC_URL and no Turnstile. */
const EXPECTED_HEADERS = securityHeaders({ hsts: true, turnstile: false });

const COMMITTED_DOCUMENT: unknown = JSON.parse(
  readFileSync(new URL("../../../packages/api-client/openapi/v1.json", import.meta.url), "utf8"),
);

/**
 * The client address as Cloudflare would set it (08 §4.1). The Worker needs it on IP-using routes;
 * the Node build (TRUST_PROXY=false) ignores it and uses the socket address.
 */
const CLIENT_IP = { "CF-Connecting-IP": "203.0.113.10" } as const;

export function expectSecurityHeaders(response: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
}

/** The instance's own origin, which cookie requests must send (08 §3). */
const CONTRACT_ORIGIN = new URL(CONTRACT_VARS.PUBLIC_URL).origin;

/** The built-in `enable` list, as the dictionary build publishes it. */
function enableWords(): string[] {
  const served = new URL("../../../packages/dictionary/generated/served/", import.meta.url);
  const index = JSON.parse(readFileSync(new URL("index.json", served), "utf8")) as {
    dictionaries: { id: string; version: number; wordsSha256: string }[];
  };
  const manifest = index.dictionaries.find((entry) => entry.id === "enable");
  if (manifest === undefined) throw new Error("no built-in enable list");
  const name = `${manifest.id}-v${String(manifest.version)}.${manifest.wordsSha256.slice(0, 16)}.txt`;
  return readFileSync(new URL(name, served), "utf8").split("\n");
}

/**
 * An opening play: a word of the built-in list spelled from the rack (blanks standing in), across
 * the centre, or null when the rack spells none (a few racks, about 1 in 120, don't).
 */
function openingPlay(size: number, rack: readonly string[]) {
  const centre = Math.floor(size / 2);
  for (const word of enableWords()) {
    if (word.length < 2 || word.length > rack.length) continue;
    const left = [...rack];
    const tiles: { tile: string; letter?: string }[] = [];
    for (const letter of word) {
      const own = left.indexOf(letter);
      const blank = left.indexOf("?");
      const index = own >= 0 ? own : blank;
      if (index < 0) break;
      left.splice(index, 1);
      tiles.push(own >= 0 ? { tile: letter } : { tile: "?", letter });
    }
    if (tiles.length !== word.length) continue;
    return {
      type: "play" as const,
      placements: tiles.map((tile, i) => ({ row: centre, col: centre + i, ...tile })),
    };
  }
  return null;
}

export function contractSuite(name: string, target: () => Target): void {
  const client = () =>
    createApiClient({
      baseUrl: "http://contract.test",
      fetch: (request: Request) => target().fetch(request),
    });
  const raw = (path: string) => target().fetch(new Request(new URL(path, "http://contract.test")));

  describe(`API contract: ${name}`, () => {
    it("GET /api/v1/health answers { ok: true }, uncached, with the security headers", async () => {
      const { data, response } = await client().GET("/api/v1/health");
      expect(response.status).toBe(200);
      expect(data).toEqual({ ok: true });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expectSecurityHeaders(response);
    });

    it("GET /api/health answers unversioned", async () => {
      const response = await raw("/api/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it("GET /api/v1/config returns exactly the public configuration schema", async () => {
      const { data, response } = await client().GET("/api/v1/config");
      expect(response.status).toBe(200);
      expect(ClientConfigSchema.parse(data)).toEqual(data);
    });

    describe("games (05 §Games)", () => {
      it("serves a game type's rules publicly", async () => {
        const { data, response } = await client().GET("/api/v1/games/types/{type}/rules", {
          params: { path: { type: "words" } },
        });
        expect(response.status).toBe(200);
        expect(data?.type).toBe("words");
        expect(data?.markdown.length).toBeGreaterThan(0);
        const unknown = await raw("/api/v1/games/types/nope/rules");
        expect(unknown.status).toBe(404);
      });

      it.each(["/api/v1/catalog", "/api/v1/games", `/api/v1/games/${crypto.randomUUID()}`])(
        "GET %s needs a session",
        async (path) => {
          const response = await raw(path);
          expect(response.status).toBe(401);
          expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe(
            "UNAUTHENTICATED",
          );
        },
      );

      it("serves the built-in word lists to clients by their versioned, hashed names", async () => {
        const index = JSON.parse(
          readFileSync(
            new URL("../../../packages/dictionary/generated/served/index.json", import.meta.url),
            "utf8",
          ),
        ) as {
          dictionaries: { id: string; version: number; wordsSha256: string; bytes: number }[];
        };
        const manifest = index.dictionaries[0];
        expect(manifest).toBeDefined();
        if (manifest === undefined) return;
        const name = `${manifest.id}-v${String(manifest.version)}.${manifest.wordsSha256.slice(0, 16)}.txt`;
        const response = await raw(`/assets/dictionaries/${name}`);
        expect(response.status).toBe(200);
        expect((await response.text()).length).toBe(manifest.bytes);
        expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      });
    });

    it("plays a word from the built-in list: the runtime's dictionary loader runs (A2 review P-8)", async () => {
      const repos = await target().repos();
      const now = Date.now();
      const player = async (name: string) => {
        const id = crypto.randomUUID();
        const email = normaliseAddress(`contract-${id}@example.org`);
        if (email === null) throw new Error("not an address");
        await repos.users.createOrGetByEmail({
          id,
          email,
          displayName: name,
          onboardedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        const token = await createSession(repos, id, now, undefined);
        return { id, email, cookie: `__Host-sid=${token}` };
      };
      const as = (who: { cookie: string }) => ({ Cookie: who.cookie, Origin: CONTRACT_ORIGIN });
      /** Fresh players and a fresh game (so no pair limit) until a rack spells a word; bounded. */
      const ATTEMPTS = 25;
      let setup: {
        gameId: string;
        mover: Awaited<ReturnType<typeof player>>;
        version: number;
        action: NonNullable<ReturnType<typeof openingPlay>>;
      } | null = null;
      for (let attempt = 0; attempt < ATTEMPTS && setup === null; attempt++) {
        const [a, b] = [await player("Ada"), await player("Bo")];
        const created = await client().POST("/api/v1/games", {
          body: { gameType: "words", invitees: [{ email: b.email }] },
          headers: as(a),
        });
        expect(created.response.status).toBe(201);
        const gameId = created.data?.game.id ?? "";
        const accepted = await client().POST("/api/v1/games/{id}/accept", {
          params: { path: { id: gameId } },
          body: { expectedVersion: created.data?.game.version ?? 0 },
          headers: as(b),
        });
        expect(accepted.data?.game.status).toBe("active");
        const seat = accepted.data?.game.toAct[0];
        const mover =
          accepted.data?.game.players.find((row) => row.seat === seat)?.userId === a.id ? a : b;
        const read = await client().GET("/api/v1/games/{id}", {
          params: { path: { id: gameId } },
          headers: as(mover),
        });
        const view = read.data?.view as { board: unknown[][]; yourRack: string[] };
        const action = openingPlay(view.board.length, view.yourRack);
        if (action !== null) {
          setup = { gameId, mover, version: read.data?.game.version ?? 0, action };
        }
      }
      if (setup === null) {
        throw new Error(
          `no rack spelled a word in ${String(ATTEMPTS)} games: the dealer is broken`,
        );
      }
      const { gameId, mover, action } = setup;
      const preview = await client().POST("/api/v1/games/{id}/preview", {
        params: { path: { id: gameId } },
        body: { action },
        headers: as(mover),
      });
      expect(preview.response.status).toBe(200);
      const played = await client().POST("/api/v1/games/{id}/actions", {
        params: { path: { id: gameId } },
        body: { expectedVersion: setup.version, action },
        headers: as(mover),
      });
      expect(played.response.status).toBe(200);
      expect((played.data?.record as { type: string }).type).toBe("play");
    });

    it("GET /api/v1/openapi.json serves the committed document", async () => {
      const response = await raw("/api/v1/openapi.json");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(COMMITTED_DOCUMENT);
    });

    describe("sign-in (06 §3–§4)", () => {
      /** A request as a browser on another site, or a script, would send it. */
      const send = (
        path: string,
        init: { method: string; body?: string; headers?: Record<string, string> },
      ) =>
        target().fetch(
          new Request(new URL(path, "http://contract.test"), {
            method: init.method,
            headers: { ...CLIENT_IP, ...init.headers },
            ...(init.body === undefined ? {} : { body: init.body }),
          }),
        );
      const json = { "Content-Type": "application/json" };

      it("POST /api/v1/auth/otp/request answers 202 {}", async () => {
        const { data, response } = await client().POST("/api/v1/auth/otp/request", {
          body: { email: `contract-${crypto.randomUUID()}@example.org` },
          headers: CLIENT_IP,
        });
        expect(response.status).toBe(202);
        expect(data).toEqual({});
      });

      it("POST /api/v1/auth/otp/verify with a wrong code answers 400 INVALID_CODE", async () => {
        const { error, response } = await client().POST("/api/v1/auth/otp/verify", {
          body: { email: `contract-${crypto.randomUUID()}@example.org`, code: "12345678" },
          headers: CLIENT_IP,
        });
        expect(response.status).toBe(400);
        expect(error?.error.code).toBe("INVALID_CODE");
      });

      it("GET /api/v1/me without a session answers 401", async () => {
        const { error, response } = await client().GET("/api/v1/me");
        expect(response.status).toBe(401);
        expect(error?.error.code).toBe("UNAUTHENTICATED");
      });

      it("a cookie request without this instance's Origin answers 403 BAD_ORIGIN", async () => {
        const response = await send("/api/v1/auth/logout", {
          method: "POST",
          body: "{}",
          headers: { ...json, Cookie: `__Host-sid=${"A".repeat(43)}` },
        });
        expect(response.status).toBe(403);
        expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("BAD_ORIGIN");
      });

      it("a body that isn't JSON answers 415", async () => {
        const response = await send("/api/v1/auth/otp/request", {
          method: "POST",
          body: "email=a@example.org",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        expect(response.status).toBe(415);
      });

      describe("the unsubscribe route (05 §Email links, alpha A6)", () => {
        const PATH = "/api/v1/email/unsubscribe";
        const oneClick = (token: string) =>
          send(`${PATH}?t=${token}`, {
            method: "POST",
            body: "List-Unsubscribe=One-Click",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: "https://mail.example",
            },
          });

        it("serves its page, uncached and with the security headers, for any token", async () => {
          const response = await raw(`${PATH}?t=not-a-token`);
          expect(response.status).toBe(200);
          expect(response.headers.get("Content-Type")).toMatch(/^text\/html/u);
          expectSecurityHeaders(response);
          expect(await response.text()).toContain("This link isn&#39;t valid");
          expect((await oneClick("not-a-token")).status).toBe(200);
        });

        it("a cross-origin one-click POST turns email nudges off", async () => {
          const repos = await target().repos();
          const id = crypto.randomUUID();
          const email = normaliseAddress(`contract-${id}@example.org`);
          if (email === null) throw new Error("bad address");
          const keys = await deriveSubkeys(
            Uint8Array.from(atob(CONTRACT_SECRETS.APP_SECRET), (c) => c.charCodeAt(0)),
          );
          const emailId = await emailIdOf(keys, email);
          await repos.users.create({ id, email, createdAt: 0, updatedAt: 0 });
          await repos.users.setEmailNudges(id, { enabled: true, emailId, updatedAt: 0 });
          const token = await unsubscribeToken(keys, { purpose: "nudges", emailId });
          const response = await oneClick(token);
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("Email nudges are off");
          expect(JSON.parse((await repos.users.findById(id))?.settings ?? "{}")).toEqual({
            emailNudges: false,
          });
        });
      });

      it("GET /__dev/emails answers 404 in a production config (08 T19)", async () => {
        const response = await raw("/__dev/emails");
        expect(response.status).toBe(404);
      });
    });

    it("answers unknown API paths with a JSON 404 error", async () => {
      const response = await raw("/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(ErrorResponseSchema.parse(await response.json()).error.code).toBe("NOT_FOUND");
      expectSecurityHeaders(response);
    });
  });
}
