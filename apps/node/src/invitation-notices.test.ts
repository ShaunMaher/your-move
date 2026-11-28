/**
 * Invitation notices (alpha A20; docs/spec/06-auth.md §6.2, §6.4, §6.6, 03 §7, 08 T4, T18, §4):
 * the generic "You have a new game invitation." push to an existing user who is invited, at most
 * one a fixed UTC day, never for `hidden` or `inert` invitations; the invitation email to one who
 * has email nudges on, through A17's invite-email caps and the suppression list, with the `nudges`
 * unsubscribe; the claim's push; and Q3's sameness for every typed address now that some of them
 * are pushed to and mailed. The real app on a real SQLite database; pushes go to a recording fetch
 * and are decrypted with the device's keys, emails come from the capturing sender.
 */
import {
  type CapturedEmail,
  deriveSubkeys,
  emailId as emailIdOf,
  normaliseAddress,
  type Repositories,
  toBase64Url,
} from "@your-move/server";
import { decryptPushMessage, testClientKeys, type TestClientKeys } from "@your-move/server/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  call,
  createGame,
  freshEmail,
  gameHarness,
  getGame,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness, HOUR } from "./test-harness.js";

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
/** Every push request, by endpoint, in order. */
let sent: { readonly endpoint: string; readonly body: Uint8Array }[];

afterEach(() => {
  h.close();
});

/** The app with push configured, pushes going to a fake push service that accepts them all. */
function harness(env: Record<string, string> = {}, wrapRepos?: (r: Repositories) => Repositories) {
  sent = [];
  h = gameHarness(
    { ...vapid, ...env },
    {
      pushFetch: (input, init) => {
        sent.push({
          endpoint: typeof input === "string" ? input : "(not a string)",
          body: init?.body as Uint8Array,
        });
        return Promise.resolve(new Response(null, { status: 201 }));
      },
      ...(wrapRepos === undefined ? {} : { wrapRepos }),
    },
  );
}

const now = (): number => h.platform.now().getTime();

/** The generic invitation push (06 §6.2). */
const INVITATION = {
  title: "Family Games",
  body: "You have a new game invitation.",
  url: "/",
  tag: "invitation",
};

interface Device {
  readonly endpoint: string;
  readonly keys: TestClientKeys;
}

/** Subscribes a new device of the player's to pushes. */
async function device(player: Player): Promise<Device> {
  const of = {
    endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
    keys: await testClientKeys(),
  };
  const subscribed = await call(h, player, "POST", "/api/v1/push/subscriptions", {
    endpoint: of.endpoint,
    keys: { p256dh: toBase64Url(of.keys.publicKey), auth: toBase64Url(of.keys.auth) },
  });
  expect(subscribed.status).toBe(204);
  return of;
}

/** The decrypted pushes a device received, in order, once background work is done. */
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

/** Turns the player's email nudges on, as Settings does. */
async function nudgesOn(player: Player): Promise<void> {
  const answer = await call(h, player, "PATCH", "/api/v1/me", { settings: { emailNudges: true } });
  expect(answer.status).toBe(200);
}

/** An inviter past the new-account rate: signed up over 7 days ago (06 §6.6). */
async function seasoned(name: string): Promise<Player> {
  const player = await signUp(h, name);
  h.exec("UPDATE users SET created_at = ? WHERE id = ?", now() - 8 * DAY, player.id);
  return player;
}

/** The invitation emails (06 §6.2) to an address, not the invite emails (§6.3). */
async function invitationEmailsTo(address: string): Promise<CapturedEmail[]> {
  return (await h.emails()).filter(
    (email) => email.to === address && email.text.includes("you turned on email nudges"),
  );
}

/** The invite emails to an email-invite seat (06 §6.3). */
async function inviteEmailsTo(address: string): Promise<CapturedEmail[]> {
  return (await h.emails()).filter(
    (email) => email.to === address && email.text.includes(" has invited you to play "),
  );
}

async function emailIdOfAddress(address: string): Promise<string> {
  const keys = await deriveSubkeys(h.platform.config.appSecret);
  const normalised = normaliseAddress(address);
  if (normalised === null) throw new Error("invalid test address");
  return emailIdOf(keys, normalised);
}

async function suppress(address: string, reason: string): Promise<void> {
  h.exec(
    "INSERT INTO email_suppressions (email_hash, reason, created_at) VALUES (?, ?, ?)",
    await emailIdOfAddress(address),
    reason,
    now(),
  );
}

function block(blocker: Player, blocked: Player): void {
  h.exec(
    "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
    blocker.id,
    blocked.id,
    now(),
  );
}

function pastOpponents(a: Player, b: Player): void {
  for (const [one, other] of [
    [a, b],
    [b, a],
  ] as const) {
    h.exec(
      "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
      one.id,
      other.id,
      now(),
    );
  }
}

/** Invites one address to a new words game; the creator's response. */
async function invite(creator: Player, email: string, extra: Record<string, unknown> = {}) {
  const created = await call<{ game: { id: string } }>(h, creator, "POST", "/api/v1/games", {
    gameType: "words",
    invitees: [{ email }],
    ...extra,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

const deliveryOf = (gameId: string, userId: string) =>
  h.query(
    "SELECT delivery FROM game_players WHERE game_id = ? AND user_id = ?",
    gameId,
    userId,
  )[0]?.["delivery"];

/** One-click unsubscribe, as a mail client posts it (RFC 8058). */
function oneClick(url: string) {
  const parsed = new URL(url);
  return h.request("POST", `${parsed.pathname}${parsed.search}`, undefined, {
    origin: null,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    rawBody: "List-Unsubscribe=One-Click",
  });
}

describe("the generic invitation push (06 §6.2, 03 §7)", () => {
  it("goes to a user invited by address, a pick under whoCanAddMe nobody and a pick in an AI-assistance game; never to the creator", async () => {
    harness();
    const [ada, bo, cy, di] = [
      await signUp(h, "Ada"),
      await signUp(h, "Bo"),
      await signUp(h, "Cy"),
      await signUp(h, "Di"),
    ];
    const phones = {
      ada: await device(ada),
      bo: await device(bo),
      cy: await device(cy),
      di: await device(di),
    };
    pastOpponents(ada, cy);
    pastOpponents(ada, di);
    h.exec(`UPDATE users SET settings = '{"whoCanAddMe":"nobody"}' WHERE id = ?`, cy.id);

    const typed = await createGame(h, ada, { gameType: "words", invitees: [{ email: bo.email }] });
    const nobody = await createGame(h, ada, { gameType: "words", invitees: [{ userId: cy.id }] });
    const assisted = await createGame(h, ada, {
      gameType: "words",
      aiAssistance: "allowed",
      invitees: [{ userId: di.id }],
    });
    for (const game of [typed, nobody, assisted]) expect(game.status).toBe("lobby");
    expect(await received(phones.bo)).toEqual([INVITATION]);
    expect(await received(phones.cy)).toEqual([INVITATION]);
    expect(await received(phones.di)).toEqual([INVITATION]);
    expect(await received(phones.ada)).toEqual([]);
  });

  it("names nobody: not the creator, the game, its id or any address", async () => {
    harness();
    const ada = await signUp(h, "Ada Quill");
    const bo = await signUp(h, "Bo");
    const phone = await device(bo);
    const game = await createGame(h, ada, { gameType: "words", invitees: [{ email: bo.email }] });
    await h.drain();
    const [push] = sent;
    const text = new TextDecoder().decode(
      await decryptPushMessage(push?.body ?? new Uint8Array(), phone.keys),
    );
    expect(JSON.parse(text)).toEqual(INVITATION);
    for (const secret of ["Ada", "Quill", "Words", "words", game.id, ada.email, bo.email]) {
      expect(text).not.toContain(secret);
    }
  });

  it("sends at most one a fixed UTC day per recipient; one without a device spends nothing", async () => {
    harness();
    h.setTime(Date.UTC(2026, 0, 5, 10));
    const bo = await signUp(h, "Bo");
    const dee = await signUp(h, "Dee");
    const phone = await device(bo);
    // Strangers' invitations, one each, so the inbound cap (3 a day) never hides one.
    await invite(await seasoned("Ann"), bo.email);
    await invite(await seasoned("Al"), bo.email);
    await invite(await seasoned("Ash"), dee.email);
    expect(await received(phone)).toEqual([INVITATION]);
    // Dee had no device for her first one: her day's push is still there.
    const deePhone = await device(dee);
    await invite(await seasoned("Abe"), dee.email);
    expect(await received(deePhone)).toEqual([INVITATION]);
    // The next UTC day, the next invitation pushes again, even an hour after the last.
    h.setTime(Date.UTC(2026, 0, 6, 0, 30));
    await invite(await seasoned("Amy"), bo.email);
    expect(await received(phone)).toEqual([INVITATION, INVITATION]);
    expect(
      h.query("SELECT key, count FROM rate_limits WHERE key LIKE 'INVITATION_PUSHES_USER_DAY:%'"),
    ).toHaveLength(3);
  });

  it("never for a hidden or an inert invitation, which spend nothing of the day's push", async () => {
    harness();
    h.setTime(Date.UTC(2026, 0, 5, 23));
    const ada = await seasoned("Ada");
    const bo = await signUp(h, "Bo");
    const phone = await device(bo);
    await invite(ada, bo.email);
    expect(await received(phone)).toEqual([INVITATION]);
    // Two hours later, a new UTC day: the day's push is free, but Ada's second invitation is over
    // her per-creator inbound cap (06 §6.7), so hidden.
    h.setTime(Date.UTC(2026, 0, 6, 1));
    const hidden = await invite(ada, bo.email);
    expect(deliveryOf(hidden.game.id, bo.id)).toBe("hidden");
    // A creator Bo has blocked: inert.
    const eve = await seasoned("Eve");
    block(bo, eve);
    const inert = await invite(eve, bo.email);
    expect(deliveryOf(inert.game.id, bo.id)).toBe("inert");
    expect(await received(phone)).toEqual([INVITATION]);
    // The day's one push is still there for a normal invitation.
    await invite(await seasoned("Cy"), bo.email);
    expect(await received(phone)).toEqual([INVITATION, INVITATION]);
  });

  it("reads the game when it is sent: nothing once the lobby has ended", async () => {
    let cancelFirst: (() => Promise<void>) | null = null;
    harness({}, (repos) => ({
      ...repos,
      games: {
        ...repos.games,
        load: async (...args) => {
          // The push's read of the game, after the response: cancel the lobby just before it.
          const run = cancelFirst;
          cancelFirst = null;
          if (run !== null) await run();
          return repos.games.load(...args);
        },
      },
    }));
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    const phone = await device(bo);
    const game = await createGame(h, ada, { gameType: "words", invitees: [{ email: bo.email }] });
    cancelFirst = async () => {
      h.exec("UPDATE games SET status = 'cancelled' WHERE id = ?", game.id);
      await Promise.resolve();
    };
    // The response came first; the background push hasn't read the game yet.
    expect(await received(phone)).toEqual([]);
  });

  it("is sent to the claimant of an email-invite seat, at onboarding and by the sweep; never for an inert claim", async () => {
    harness();
    const ada = await seasoned("Ada");
    // At onboarding: subscribed while signing up, then onboarded with the address.
    const sam = await signUp(h, null);
    const samPhone = await device(sam);
    await invite(ada, sam.email);
    expect(await received(samPhone)).toEqual([]);
    expect((await call(h, sam, "PATCH", "/api/v1/me", { displayName: "Sam" })).status).toBe(200);
    expect(await received(samPhone)).toEqual([INVITATION]);

    // By the sweep: onboarding committed while the game was being created, so nothing claimed.
    const ray = await signUp(h, null);
    const rayPhone = await device(ray);
    await invite(await seasoned("Bea"), ray.email);
    h.exec("UPDATE users SET onboarded_at = ?, display_name = 'Ray' WHERE id = ?", now(), ray.id);
    expect((await h.sweep()).claims).toEqual({ claimed: 1, skipped: 0 });
    expect(await received(rayPhone)).toEqual([INVITATION]);

    // An inert claim: the claimant and the creator have a block.
    const hal = await signUp(h, null);
    const halPhone = await device(hal);
    const cyd = await seasoned("Cyd");
    await invite(cyd, hal.email);
    block(cyd, hal);
    expect((await call(h, hal, "PATCH", "/api/v1/me", { displayName: "Hal" })).status).toBe(200);
    expect(await received(halPhone)).toEqual([]);
  });

  it("isn't sent at all without VAPID configuration", async () => {
    h = gameHarness({}, { pushFetch: () => Promise.reject(new Error("no push expected")) });
    sent = [];
    const ada = await signUp(h, "Ada");
    const bo = await signUp(h, "Bo");
    await createGame(h, ada, { gameType: "words", invitees: [{ email: bo.email }] });
    await h.drain();
    expect(h.logs.filter((line) => line["level"] === "error")).toEqual([]);
  });
});

describe("the invitation email to a user with email nudges on (06 §6.2)", () => {
  it("says who invited them to what, with the nudges unsubscribe, and nothing of the game", async () => {
    harness();
    const ada = await seasoned("Ada");
    const bo = await signUp(h, "Bo");
    await nudgesOn(bo);
    const { game } = await invite(ada, bo.email);
    const [mail, ...more] = await invitationEmailsTo(bo.email);
    expect(more).toEqual([]);
    expect(await inviteEmailsTo(bo.email)).toEqual([]);
    expect(mail?.subject).toBe("Ada invited you to play Words on Family Games");
    const unsubscribe = mail?.listUnsubscribe ?? "";
    expect(unsubscribe).toMatch(
      /^https:\/\/play\.example\.org\/api\/v1\/email\/unsubscribe\?t=[A-Za-z0-9_-]+$/u,
    );
    expect(mail?.text).toBe(
      [
        "Ada invited you to play Words on Family Games.",
        "Accept or decline it in your list of games: https://play.example.org",
        "You're getting this because you turned on email nudges in Family Games: one email for each new invitation, and a reminder when a game has waited a day for your move.",
        "Turn them off in Settings: https://play.example.org/settings",
        `Or unsubscribe with one click: ${unsubscribe}`,
      ].join("\n\n") + "\n",
    );
    for (const secret of [game.id, ada.email]) {
      expect(mail?.text).not.toContain(secret);
      expect(mail?.html).not.toContain(secret);
    }
    expect(h.query("SELECT sent_at FROM invites WHERE game_id = ?", game.id)).toEqual([
      { sent_at: now() },
    ]);
  });

  it("is never sent without nudges, to a suppressed address (any reason), or for a hidden or inert invitation", async () => {
    harness();
    const ada = await seasoned("Ada");
    const [off, bounced, unsubscribed, hidden, inert] = [
      await signUp(h, "Off"),
      await signUp(h, "Bounced"),
      await signUp(h, "Unsub"),
      await signUp(h, "Hidden"),
      await signUp(h, "Inert"),
    ];
    for (const player of [bounced, unsubscribed, hidden, inert]) await nudgesOn(player);
    await suppress(bounced.email, "bounced");
    await suppress(unsubscribed.email, "unsubscribed");
    block(inert, ada);
    // Ada's first invitation today is mailed; her second is over her inbound cap (06 §6.7).
    await invite(ada, hidden.email);
    h.advance(HOUR);
    const before = (await invitationEmailsTo(hidden.email)).length;
    expect(before).toBe(1);
    for (const player of [off, bounced, unsubscribed, hidden, inert]) {
      // An hour apart: the creator's 5 typed addresses an hour (08 §4).
      await invite(ada, player.email);
      h.advance(HOUR);
    }
    expect(
      await Promise.all(
        [off, bounced, unsubscribed, inert].map(
          async (p) => (await invitationEmailsTo(p.email)).length,
        ),
      ),
    ).toEqual([0, 0, 0, 0]);
    expect((await invitationEmailsTo(hidden.email)).length).toBe(before);
  });

  it("goes to a pick seated as an invitation too, using none of the inviter's allowance", async () => {
    harness({ LIMIT_INVITE_EMAILS_INVITER_DAY: "1" });
    const ada = await seasoned("Ada");
    const cy = await signUp(h, "Cy");
    pastOpponents(ada, cy);
    await nudgesOn(cy);
    const picked = await createGame(h, ada, {
      gameType: "words",
      aiAssistance: "allowed",
      invitees: [{ userId: cy.id }],
    });
    expect(picked.status).toBe("lobby");
    expect(await invitationEmailsTo(cy.email)).toHaveLength(1);
    // Ada's one invite email of the day is still there for a typed address.
    const address = freshEmail();
    await invite(ada, address);
    expect(await inviteEmailsTo(address)).toHaveLength(1);
  });

  it("stops after a one-click unsubscribe, which turns nudges off", async () => {
    harness();
    const bo = await signUp(h, "Bo");
    await nudgesOn(bo);
    await invite(await seasoned("Ada"), bo.email);
    const [mail] = await invitationEmailsTo(bo.email);
    expect((await oneClick(mail?.listUnsubscribe ?? "")).status).toBe(200);
    const me = await call<{ settings: { emailNudges: boolean } }>(h, bo, "GET", "/api/v1/me");
    expect(me.body.settings.emailNudges).toBe(false);
    await invite(await seasoned("Cy"), bo.email);
    expect(await invitationEmailsTo(bo.email)).toHaveLength(1);
  });

  it("counts toward the per-address and instance-wide invite-email caps (08 §4)", async () => {
    harness({ LIMIT_INVITE_EMAILS_GLOBAL_DAY: "2" });
    const bo = await signUp(h, "Bo");
    await nudgesOn(bo);
    // Per address: 3 in 30 days, across inviters, a day apart (the inbound cap).
    for (const name of ["Ann", "Al", "Ash", "Abe"]) {
      h.advance(DAY);
      await invite(await seasoned(name), bo.email);
    }
    expect(await invitationEmailsTo(bo.email)).toHaveLength(3);
    // Instance-wide: two today, then an unknown address isn't mailed. Two days on, so the
    // sliding estimate carries nothing over (the 4th above counted toward it, as A17's do).
    h.advance(2 * DAY);
    const cy = await signUp(h, "Cy");
    await nudgesOn(cy);
    await invite(await seasoned("Ben"), cy.email);
    const dee = await signUp(h, "Dee");
    await nudgesOn(dee);
    await invite(await seasoned("Bob"), dee.email);
    const address = freshEmail();
    await invite(await seasoned("Bud"), address);
    expect([
      (await invitationEmailsTo(cy.email)).length,
      (await invitationEmailsTo(dee.email)).length,
      (await inviteEmailsTo(address)).length,
    ]).toEqual([1, 1, 0]);
  });

  it("is never sent on a claim: the seat's one email was its invite email", async () => {
    harness();
    const ada = await seasoned("Ada");
    const ray = await signUp(h, null);
    await nudgesOn(ray);
    await invite(ada, ray.email);
    expect(await inviteEmailsTo(ray.email)).toHaveLength(1);
    h.exec("UPDATE users SET onboarded_at = ?, display_name = 'Ray' WHERE id = ?", now(), ray.id);
    expect((await h.sweep()).claims).toEqual({ claimed: 1, skipped: 0 });
    expect(await invitationEmailsTo(ray.email)).toEqual([]);
    expect(await inviteEmailsTo(ray.email)).toHaveLength(1);
  });
});

/** The repositories, each call's name (and for list arguments, how many) recorded. */
function recording(repos: Repositories, calls: string[]): Repositories {
  const wrap = <T extends object>(group: string, repo: T): T =>
    new Proxy(repo, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const first = args[0];
          calls.push(
            `${group}.${String(key)}${Array.isArray(first) ? `(${String(first.length)})` : ""}`,
          );
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return Object.fromEntries(
    Object.entries(repos).map(([group, repo]) => [group, wrap(group, repo as object)]),
  ) as unknown as Repositories;
}

/** The sum of every rate-limit counter: what a request adds to them, real or `silent`. */
const counted = (): number =>
  Number(h.query("SELECT coalesce(sum(count), 0) AS n FROM rate_limits")[0]?.["n"]);

/** The response with what differs between any two games blanked out. */
const shape = (body: unknown) =>
  JSON.parse(
    JSON.stringify(body)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
      .replace(/"invitedAs":"[^"]*"/gu, '"invitedAs":"<address>"')
      .replace(/"(createdAt|lastActionAt)":[0-9]+/gu, '"$1":0'),
  ) as unknown;

describe("Q3: every typed address alike, with the invitation's push and email (06 §6.1, 08 T4)", () => {
  it("answers, reads, writes and schedules the same whether the address is pushed to, mailed, neither, suppressed, capped, hidden or blocked", async () => {
    const calls: string[] = [];
    // The creator's own allowances raised out of the way of nine addresses in a day.
    harness(
      {
        LIMIT_EMAIL_INVITEES_USER_DAY: "50",
        LIMIT_INVITE_EMAILS_INVITER_DAY: "50",
        LIMIT_INVITE_EMAILS_INVITER_30D: "50",
      },
      (repos) => recording(repos, calls),
    );
    const ada = await seasoned("Ada");
    /** An onboarded user with a device and email nudges on. */
    const reachable = async (name: string) => {
      const player = await signUp(h, name);
      await device(player);
      await nudgesOn(player);
      return player;
    };
    // Three invite emails from others already: this address is over its own cap.
    const capped = freshEmail();
    for (const name of ["Cy", "Di", "Ed"]) {
      await invite(await seasoned(name), capped);
      h.advance(DAY);
    }
    // Every case below lands in one UTC day.
    h.setTime(Date.UTC(2026, 0, 5, 1));
    const pushedToday = await reachable("Pat");
    await invite(await seasoned("Fay"), pushedToday.email);
    // Ada's own first invitation today: her second, below, is over her inbound cap (06 §6.7).
    const hidden = await reachable("Hid");
    await invite(ada, hidden.email);
    const blocked = await reachable("Bea");
    block(blocked, ada);
    const suppressed = await reachable("Sup");
    await suppress(suppressed.email, "bounced");
    const cases = {
      unknown: freshEmail(),
      known: (await signUp(h, "Bo")).email,
      reachable: (await reachable("Rea")).email,
      pushedToday: pushedToday.email,
      halfway: (await signUp(h, null)).email,
      suppressed: suppressed.email,
      capped,
      hidden: hidden.email,
      blocked: blocked.email,
    };
    const seen: Record<string, unknown> = {};
    for (const [name, address] of Object.entries(cases)) {
      h.advance(HOUR);
      await h.drain();
      calls.length = 0;
      const before = {
        counted: counted(),
        scheduled: h.backgroundScheduled(),
        logs: h.logs.length,
      };
      const body = await invite(ada, address);
      const request = h.logs.slice(before.logs).find((line) => line["msg"] === "request");
      seen[name] = {
        shape: shape(body),
        // The session's last-seen refresh runs alongside, so its place in the order varies.
        calls: calls.filter((call) => call !== "sessions.touch"),
        counted: counted() - before.counted,
        scheduled: h.backgroundScheduled() - before.scheduled,
        request: Object.keys(request ?? {}).sort(),
        status: request?.["status"],
      };
    }
    for (const name of Object.keys(cases)) expect(seen[name], name).toEqual(seen["unknown"]);
    // Not vacuous: who was mailed what, and which pushes went out.
    const mailed = await Promise.all(
      Object.values(cases).map(async (address) => [
        (await inviteEmailsTo(address)).length,
        (await invitationEmailsTo(address)).length,
      ]),
    );
    expect(Object.fromEntries(Object.keys(cases).map((name, i) => [name, mailed[i]]))).toEqual({
      unknown: [1, 0],
      known: [0, 0],
      reachable: [0, 1],
      // Mailed by Fay's invitation, and Ada's too: one email per invitation; pushed once today.
      pushedToday: [0, 2],
      halfway: [1, 0],
      suppressed: [0, 0],
      capped: [3, 0],
      // Ada's first invitation was mailed; her second, hidden, wasn't.
      hidden: [0, 1],
      blocked: [0, 0],
    });
    const pushedTo = (player: Player) =>
      h.query(
        "SELECT count FROM rate_limits WHERE key = ?",
        `INVITATION_PUSHES_USER_DAY:${player.id}`,
      )[0]?.["count"];
    // Pat's counter took Fay's push and Ada's refused one; Bea's blocked invitation took nothing.
    expect([pushedTo(pushedToday), pushedTo(blocked)]).toEqual([2, undefined]);
  });

  it("schedules one background task for a pick-only game exactly when a pick is invited", async () => {
    harness();
    const ada = await seasoned("Ada");
    const bo = await signUp(h, "Bo");
    const cy = await signUp(h, "Cy");
    pastOpponents(ada, bo);
    pastOpponents(ada, cy);
    h.exec(`UPDATE users SET settings = '{"whoCanAddMe":"nobody"}' WHERE id = ?`, cy.id);
    await h.drain();
    let before = h.backgroundScheduled();
    // Bo is added at once: only the "added you" push's task (push is on).
    await createGame(h, ada, { gameType: "example", invitees: [{ userId: bo.id }] });
    expect(h.backgroundScheduled() - before).toBe(1);
    await h.drain();
    before = h.backgroundScheduled();
    // Cy is invited: the invitation notices' one task.
    const game = await createGame(h, ada, { gameType: "example", invitees: [{ userId: cy.id }] });
    expect(h.backgroundScheduled() - before).toBe(1);
    expect((await getGame(h, cy, game.id)).game.yourInvitation).toBe("normal");
    expect((await transition(h, cy, game.id, "accept")).status).toBe(200);
  });
});
