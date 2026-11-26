/**
 * Web Push end to end on the real app (alpha A8; 05 §Push subscriptions, 03 §7, 08 T12, T18): the
 * subscription endpoints, who a game's transitions push to, what a device can read of each push,
 * and the clean-up of subscriptions a push service no longer knows. Pushes go to a recording fetch
 * and are decrypted with the device's keys, exactly as a phone would; nothing reaches a network.
 */
import { toBase64Url } from "@your-move/server";
import { decryptPushMessage, testClientKeys, type TestClientKeys } from "@your-move/server/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  act,
  call,
  createGame,
  gameHarness,
  getGame,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import type { Harness } from "./test-harness.js";

interface Sent {
  readonly endpoint: string;
  readonly body: Uint8Array;
  readonly headers: Headers;
}

/** A device: its subscription keys and the endpoint the push service gave it. */
interface Device {
  readonly endpoint: string;
  readonly keys: TestClientKeys;
}

let vapid: Record<string, string>;

beforeAll(async () => {
  // A fresh pair for this run: no key material is kept in the repository.
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  vapid = {
    VAPID_PUBLIC_KEY: toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
    VAPID_PRIVATE_KEY: jwk.d ?? "",
    VAPID_SUBJECT: "mailto:ops@example.org",
  };
});

let h: Harness;
let sent: Sent[];
/** What the fake push service answers for an endpoint (default 201). */
let answers: Map<string, number | Error>;

beforeEach(() => {
  sent = [];
  answers = new Map();
  h = gameHarness(vapid, {
    pushFetch: (input, init) => {
      // The sender always passes the endpoint's href.
      const endpoint = typeof input === "string" ? input : "(not a string)";
      sent.push({
        endpoint,
        body: init?.body as Uint8Array,
        headers: new Headers(init?.headers),
      });
      const answer = answers.get(endpoint) ?? 201;
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(new Response(null, { status: answer }));
    },
  });
});

afterEach(() => {
  h.close();
});

async function device(): Promise<Device> {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: await testClientKeys(),
  };
}

function subscription(of: Device) {
  return {
    endpoint: of.endpoint,
    keys: { p256dh: toBase64Url(of.keys.publicKey), auth: toBase64Url(of.keys.auth) },
  };
}

async function subscribe(player: Player, of: Device): Promise<number> {
  return (await call(h, player, "POST", "/api/v1/push/subscriptions", subscription(of))).status;
}

/** The decrypted pushes each device received, in order, once background work is done. */
async function received(of: Device): Promise<unknown[]> {
  await h.drain();
  return Promise.all(
    sent
      .filter((push) => push.endpoint === of.endpoint)
      .map(
        async (push) =>
          JSON.parse(
            new TextDecoder().decode(await decryptPushMessage(push.body, of.keys)),
          ) as unknown,
      ),
  );
}

const storedEndpoints = (userId: string): unknown[] =>
  h
    .query("SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint", userId)
    .map((row) => row["endpoint"]);

describe("the push subscription endpoints (05, 08 T12)", () => {
  it("saves a subscription bound to the session, idempotently", async () => {
    const ada = await signUp(h, "Ada");
    const phone = await device();
    expect(await subscribe(ada, phone)).toBe(204);
    expect(await subscribe(ada, phone)).toBe(204);
    const rows = h.query("SELECT user_id, session_id FROM push_subscriptions");
    expect(rows).toHaveLength(1);
    const [session] = h.query("SELECT id FROM sessions WHERE user_id = ?", ada.id);
    expect(rows[0]).toEqual({ user_id: ada.id, session_id: session?.["id"] });
  });

  it.each([
    ["an endpoint off the allow-list", { endpoint: "https://evilpush.apple.com/x" }],
    ["an internal address", { endpoint: "https://169.254.169.254/latest/meta-data" }],
    ["plain http", { endpoint: "http://fcm.googleapis.com/fcm/send/x" }],
    ["a port", { endpoint: "https://fcm.googleapis.com:8443/fcm/send/x" }],
    ["userinfo", { endpoint: "https://u:p@fcm.googleapis.com/fcm/send/x" }],
    ["a bad point", { keys: { p256dh: toBase64Url(new Uint8Array(65).fill(4)) } }],
    ["a short auth", { keys: { auth: toBase64Url(new Uint8Array(8)) } }],
    ["an extra field", { expirationTime: null }],
  ])("refuses %s with 400 and stores nothing", async (_name, change) => {
    const ada = await signUp(h, "Ada");
    const good = subscription(await device());
    const body = {
      ...good,
      ...change,
      keys: { ...good.keys, ...("keys" in change ? change.keys : {}) },
    };
    const result = await call(h, ada, "POST", "/api/v1/push/subscriptions", body);
    expect(result.status).toBe(400);
    expect(h.query("SELECT 1 FROM push_subscriptions")).toEqual([]);
  });

  it("is for sessions only", async () => {
    const phone = await device();
    const anonymous = await h.request("POST", "/api/v1/push/subscriptions", subscription(phone));
    expect(anonymous.status).toBe(401);
    const bearer = await h.request("POST", "/api/v1/push/subscriptions", subscription(phone), {
      headers: { Authorization: "Bearer ym_pat_x_y" },
    });
    expect(bearer.status).toBe(401);
  });

  it("removes only the viewer's own subscription", async () => {
    const [ada, bo] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const phone = await device();
    await subscribe(ada, phone);
    const other = await call(h, bo, "DELETE", "/api/v1/push/subscriptions", {
      endpoint: phone.endpoint,
    });
    expect(other.status).toBe(204);
    expect(storedEndpoints(ada.id)).toEqual([phone.endpoint]);
    const own = await call(h, ada, "DELETE", "/api/v1/push/subscriptions", {
      endpoint: phone.endpoint,
    });
    expect(own.status).toBe(204);
    expect(storedEndpoints(ada.id)).toEqual([]);
  });

  it("moves an endpoint to whoever subscribes it last (a shared device)", async () => {
    const [ada, bo] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const phone = await device();
    await subscribe(ada, phone);
    await subscribe(bo, phone);
    expect(storedEndpoints(ada.id)).toEqual([]);
    expect(storedEndpoints(bo.id)).toEqual([phone.endpoint]);
  });

  it("doesn't move an endpoint sent with other keys, and answers the same (A8-S-1)", async () => {
    const [ada, bo] = [await signUp(h, "Ada"), await signUp(h, "Bo")];
    const phone = await device();
    await subscribe(ada, phone);
    const other = await device();
    const result = await call(h, bo, "POST", "/api/v1/push/subscriptions", {
      endpoint: phone.endpoint,
      keys: subscription(other).keys,
    });
    expect(result).toEqual({ status: 204, body: null });
    expect(storedEndpoints(ada.id)).toEqual([phone.endpoint]);
    expect(storedEndpoints(bo.id)).toEqual([]);
  });

  it("keeps ten per user, the oldest evicted", async () => {
    const ada = await signUp(h, "Ada");
    const devices: Device[] = [];
    for (let index = 0; index < 11; index++) {
      const next = await device();
      devices.push(next);
      expect(await subscribe(ada, next)).toBe(204);
      h.advance(1000);
    }
    expect(storedEndpoints(ada.id)).toEqual(
      devices
        .slice(1)
        .map((d) => d.endpoint)
        .sort(),
    );
  });

  it("dies with the session on sign-out (06 §4)", async () => {
    const ada = await signUp(h, "Ada");
    await subscribe(ada, await device());
    const out = await h.request("POST", "/api/v1/auth/logout", {}, { cookie: ada.cookie });
    expect(out.status).toBe(204);
    expect(storedEndpoints(ada.id)).toEqual([]);
  });
});

describe("pushes from a game's transitions (03 §7, 08 T18)", () => {
  it("tells each player of their turn and of the game's end, never the actor", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const [adaPhone, boPhone] = [await device(), await device()];
    await subscribe(ada, adaPhone);
    await subscribe(bo, boPhone);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    const url = `/g/${created.id}`;
    const tag = `game-${created.id}`;
    // Creating the game and inviting are lobby events: no push.
    expect(await received(adaPhone)).toEqual([]);
    expect(await received(boPhone)).toEqual([]);

    // Bo's accept starts the game; Ada, the creator, is seat 0 and first to act.
    expect((await transition(h, bo, created.id, "accept")).status).toBe(200);
    expect(await received(adaPhone)).toEqual([
      {
        title: "Family Games",
        body: "Your game with Bo has started. Your turn.",
        url,
        tag,
      },
    ]);
    expect(await received(boPhone)).toEqual([]);

    expect((await act(h, ada, created.id, { type: "pass" })).status).toBe(200);
    const boPushes = await received(boPhone);
    expect(boPushes).toEqual([{ title: "Family Games", body: "Ada passed. Your turn.", url, tag }]);
    expect(await received(adaPhone)).toHaveLength(1);

    // Bo resigns: the game is over for Ada; Bo, who did it, gets nothing.
    expect((await transition(h, bo, created.id, "resign")).status).toBe(200);
    expect((await received(adaPhone)).at(-1)).toEqual({
      title: "Family Games",
      body: "Bo resigned. The game is over.",
      url,
      tag,
    });
    expect(await received(boPhone)).toHaveLength(1);
  });

  it("carries no hidden state: no rack, no state, no address", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const boPhone = await device();
    await subscribe(bo, boPhone);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    await transition(h, bo, created.id, "accept");
    expect((await act(h, ada, created.id, { type: "pass" })).status).toBe(200);
    const [push] = await received(boPhone);
    expect(Object.keys(push as object).sort()).toEqual(["body", "tag", "title", "url"]);
    const text = JSON.stringify(push);
    const [stored] = h.query("SELECT state FROM games WHERE id = ?", created.id);
    const state = JSON.parse(String(stored?.["state"])) as Record<string, unknown>;
    // Nothing of the state's own serialisation (racks, bag) appears.
    for (const value of Object.values(state)) {
      const serialised = JSON.stringify(value);
      if (serialised.length > 8) expect(text).not.toContain(serialised);
    }
    expect(text).not.toContain(ada.email);
    expect(text).not.toContain(bo.email);
    expect(text).not.toMatch(/rack|bag|tiles/iu);
    // The push service sees only ciphertext.
    const raw = new TextDecoder().decode(sent.at(-1)?.body);
    expect(raw).not.toContain("Ada");
  });

  it("deletes a subscription its push service says is gone (404, 410)", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const [gone, expired, fine] = [await device(), await device(), await device()];
    for (const each of [gone, expired, fine]) await subscribe(ada, each);
    answers.set(gone.endpoint, 404);
    answers.set(expired.endpoint, 410);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    await transition(h, bo, created.id, "accept");
    await h.drain();
    expect(sent.map((push) => push.endpoint).sort()).toEqual(
      [gone, expired, fine].map((d) => d.endpoint).sort(),
    );
    expect(storedEndpoints(ada.id)).toEqual([fine.endpoint]);
    const [row] = h.query(
      "SELECT last_success_at FROM push_subscriptions WHERE endpoint = ?",
      fine.endpoint,
    );
    expect(row?.["last_success_at"]).toBe(h.platform.now().getTime());
  });

  it("never fails the move: a push service's error is logged by class only", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const [boPhone, boTablet] = [await device(), await device()];
    await subscribe(bo, boPhone);
    await subscribe(bo, boTablet);
    answers.set(boPhone.endpoint, new TypeError(`fetch failed for ${boPhone.endpoint}`));
    answers.set(boTablet.endpoint, 500);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    await transition(h, bo, created.id, "accept");
    const moved = await act(h, ada, created.id, { type: "pass" });
    expect(moved.status).toBe(200);
    expect((await getGame(h, bo, created.id)).game.toAct).toEqual([1]);
    await h.drain();
    const failures = h.logs.filter((line) => line["msg"] === "push not delivered");
    expect(failures.map((line) => line["errorClass"] ?? line["status"]).sort()).toEqual([
      500,
      "TypeError",
    ]);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(boPhone.endpoint);
    expect(logged).not.toContain(boTablet.endpoint);
    expect(logged).not.toContain("passed");
    // A failure isn't a gone subscription: both stay.
    expect(storedEndpoints(bo.id)).toHaveLength(2);
  });
});

describe("the push to a past opponent added to a new game (alpha A12, 06 §6.2)", () => {
  const pastOpponents = (a: Player, b: Player) => {
    const at = h.platform.now().getTime();
    h.exec(
      "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?), (?, ?, ?)",
      a.id,
      b.id,
      at,
      b.id,
      a.id,
      at,
    );
  };

  it("names the creator, says when it's their turn, and never pushes to the creator", async () => {
    const [ada, bo, cy] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const [adaPhone, boPhone, cyPhone] = [await device(), await device(), await device()];
    await subscribe(ada, adaPhone);
    await subscribe(bo, boPhone);
    await subscribe(cy, cyPhone);
    pastOpponents(ada, bo);
    pastOpponents(ada, cy);

    // Words, join order: Ada plays first, so Bo is told only that he's in. One push, not two:
    // the start's own push isn't sent as well.
    const words = await createGame(h, ada, { gameType: "words", invitees: [{ userId: bo.id }] });
    expect(words.status).toBe("active");
    const wordsAt = { url: `/g/${words.id}`, tag: `game-${words.id}` };
    expect(await received(boPhone)).toEqual([
      { title: "Family Games", body: "Ada added you to a game.", ...wordsAt },
    ]);

    // The example game's first round has every seat to act: each added player is told so.
    const example = await createGame(h, ada, {
      gameType: "example",
      seats: 3,
      invitees: [{ userId: bo.id }, { userId: cy.id }],
    });
    expect(example.status).toBe("active");
    const exampleAt = { url: `/g/${example.id}`, tag: `game-${example.id}` };
    expect((await received(boPhone)).at(-1)).toEqual({
      title: "Family Games",
      body: "Ada added you to a game. Your turn.",
      ...exampleAt,
    });
    expect(await received(cyPhone)).toEqual([
      { title: "Family Games", body: "Ada added you to a game. Your turn.", ...exampleAt },
    ]);
    expect(await received(adaPhone)).toEqual([]);
  });

  it("pushes to an added player waiting in a lobby, and nothing for an invitation or a typed address", async () => {
    const [ada, bo, cy] = [await signUp(h, "Ada"), await signUp(h, "Bo"), await signUp(h, "Cy")];
    const [boPhone, cyPhone] = [await device(), await device()];
    await subscribe(bo, boPhone);
    await subscribe(cy, cyPhone);
    pastOpponents(ada, bo);
    const lobby = await createGame(h, ada, {
      gameType: "example",
      seats: 3,
      invitees: [{ userId: bo.id }, { email: cy.email }],
    });
    expect(lobby.status).toBe("lobby");
    expect(await received(boPhone)).toEqual([
      {
        title: "Family Games",
        body: "Ada added you to a game.",
        url: `/g/${lobby.id}`,
        tag: `game-${lobby.id}`,
      },
    ]);
    // The invitation push is M4's: an invitation by address sends nothing yet.
    expect(await received(cyPhone)).toEqual([]);

    // With AI assistance allowed it's an invitation (02 §4): no "added you" push.
    const invited = await createGame(h, ada, {
      gameType: "words",
      aiAssistance: "allowed",
      invitees: [{ userId: bo.id }],
    });
    expect(invited.status).toBe("lobby");
    expect(await received(boPhone)).toHaveLength(1);
  });
});

describe("pushes and sessions (A8-S-2)", () => {
  it("sends nothing to a subscription whose session has expired", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const adaPhone = await device();
    await subscribe(ada, adaPhone);
    // Ada's session idles past its sliding expiry; it is deleted only at its next use.
    h.exec(
      "UPDATE sessions SET expires_at = ? WHERE user_id = ?",
      h.platform.now().getTime(),
      ada.id,
    );
    const created = await createGame(h, bo, {
      gameType: "words",
      invitees: [{ email: ada.email }],
    });
    const adaFresh = await h.signIn(ada.email);
    expect((await transition(h, { ...ada, cookie: adaFresh }, created.id, "accept")).status).toBe(
      200,
    );
    // Bo is seat 0 and first to act; Bo passes, so it's Ada's turn.
    expect((await act(h, bo, created.id, { type: "pass" })).status).toBe(200);
    expect(await received(adaPhone)).toEqual([]);
  });
});

describe("a decline before the first move ends the game (A8-P-3)", () => {
  it("tells the others it's over, naming who declined, and not the decliner", async () => {
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const [adaPhone, boPhone] = [await device(), await device()];
    await subscribe(ada, adaPhone);
    await subscribe(bo, boPhone);
    const created = await createGame(h, ada, {
      gameType: "words",
      invitees: [{ email: bo.email }],
    });
    expect((await transition(h, bo, created.id, "accept")).status).toBe(200);
    // The start's "your turn" push has gone out before the decline, so the order is fixed.
    expect(await received(adaPhone)).toHaveLength(1);
    const declined = await transition(h, bo, created.id, "decline");
    expect(declined.status).toBe(200);
    expect(declined.body.game.status).toBe("declined");
    const pushes = await received(adaPhone);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toEqual({
      title: "Family Games",
      body: "Bo declined the game, so it's over.",
      url: `/g/${created.id}`,
      tag: `game-${created.id}`,
    });
    expect(await received(boPhone)).toEqual([]);
  });
});

describe("push without VAPID configuration", () => {
  it("publishes no key and sends nothing", async () => {
    const plain = gameHarness(
      {},
      { pushFetch: () => Promise.reject(new Error("no push expected")) },
    );
    try {
      const config = (await (await plain.request("GET", "/api/v1/config")).json()) as object;
      expect(config).not.toHaveProperty("vapidPublicKey");
      const ada = await signUp(plain, "Ada");
      const bo = await signUp(plain, "Bo");
      const phone = await device();
      await call(plain, bo, "POST", "/api/v1/push/subscriptions", subscription(phone));
      const created = await createGame(plain, bo, {
        gameType: "words",
        invitees: [{ email: ada.email }],
      });
      await transition(plain, ada, created.id, "accept");
      await act(plain, bo, created.id, { type: "pass" });
      await plain.drain();
      expect(plain.logs.filter((line) => String(line["msg"]).startsWith("push"))).toEqual([]);
    } finally {
      plain.close();
    }
  });
});
