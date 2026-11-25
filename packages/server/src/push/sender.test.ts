/** The Web Push sender: the request it makes (08 T12, RFC 8030/8291/8292) and its outcomes. */
import { describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../base64.js";
import { parseConfig } from "../config/parse.js";
import { createJsonLogger } from "../log.js";
import { PROD_ENV, TEST_VAPID } from "../test-support.js";
import { decryptPushMessage, testClientKeys } from "./decrypt.js";
import { corePushSender, createWebPushSender, type PushMessage } from "./sender.js";
import { VapidKeyError } from "./vapid.js";

const NOW = new Date(Date.UTC(2026, 0, 1));
const MESSAGE: PushMessage = {
  title: "Family Games",
  body: "Sam played QUIZ for 64. Your turn.",
  url: "/g/abc",
  tag: "game-abc",
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function setup(
  answer: () => Promise<Response> | Response = () => new Response(null, { status: 201 }),
) {
  const calls: Call[] = [];
  const lines: Record<string, unknown>[] = [];
  const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof url === "string" ? url : "(not a string)", init: init ?? {} });
    return Promise.resolve(answer());
  });
  const sender = createWebPushSender({
    vapid: { ...TEST_VAPID, subject: "mailto:ops@example.org" },
    log: createJsonLogger({
      level: "debug",
      now: () => NOW,
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    now: () => NOW,
    fetch: fetchStub,
  });
  return { sender, calls, lines, fetch: fetchStub };
}

async function target(endpoint = "https://web.push.apple.com/QGx") {
  const client = await testClientKeys();
  return {
    client,
    target: { endpoint, p256dh: toBase64Url(client.publicKey), auth: toBase64Url(client.auth) },
  };
}

describe("the Web Push sender", () => {
  it("posts the encrypted message with VAPID, no redirects and a 5 s timeout", async () => {
    const { sender, calls } = setup();
    const { client, target: subscription } = await target();
    expect(await sender.send(subscription, MESSAGE)).toEqual({ kind: "delivered" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://web.push.apple.com/QGx");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(call?.init.headers);
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("TTL")).toBe("86400");
    expect(headers.get("Urgency")).toBe("normal");
    expect(headers.get("Authorization")).toMatch(
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${TEST_VAPID.publicKey}$`, "u"),
    );
    // Only the device can read the body, and it holds exactly the message.
    const body = call?.init.body as Uint8Array;
    expect(new TextDecoder().decode(body)).not.toContain("QUIZ");
    const plain = new TextDecoder().decode(await decryptPushMessage(body, client));
    expect(JSON.parse(plain)).toEqual(MESSAGE);
  });

  it("times the request out after 5 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const { sender, calls } = setup();
      await sender.send((await target()).target, MESSAGE);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(calls[0]?.init.signal).toBe(timeout.mock.results[0]?.value);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    [200, { kind: "delivered" }],
    [201, { kind: "delivered" }],
    [202, { kind: "delivered" }],
    [404, { kind: "gone" }],
    [410, { kind: "gone" }],
    [301, { kind: "failed", status: 301 }],
    [302, { kind: "failed", status: 302 }],
    [400, { kind: "failed", status: 400 }],
    [403, { kind: "failed", status: 403 }],
    [413, { kind: "failed", status: 413 }],
    [429, { kind: "failed", status: 429 }],
    [500, { kind: "failed", status: 500 }],
  ])("reads status %i as %o", async (status, outcome) => {
    const { sender } = setup(
      () =>
        new Response(status === 301 || status === 302 ? null : "body", {
          status,
          ...(status === 301 || status === 302
            ? { headers: { Location: "http://169.254.169.254/" } }
            : {}),
        }),
    );
    expect(await sender.send((await target()).target, MESSAGE)).toEqual(outcome);
  });

  it("reports a network failure or timeout by error class, without throwing", async () => {
    const { sender } = setup(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    expect(await sender.send((await target()).target, MESSAGE)).toEqual({
      kind: "failed",
      errorClass: "DOMException",
    });
  });

  it("never posts to an endpoint that fails the allow-list: it is gone", async () => {
    const { sender, fetch } = setup();
    for (const endpoint of [
      "https://169.254.169.254/latest",
      "https://evilpush.apple.com/x",
      "http://web.push.apple.com/x",
    ]) {
      expect(await sender.send((await target(endpoint)).target, MESSAGE)).toEqual({ kind: "gone" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("alerts once and sends nothing when the VAPID keys don't match", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
    ]);
    const d = (await crypto.subtle.exportKey("jwk", other.privateKey)).d ?? "";
    const lines: Record<string, unknown>[] = [];
    const fetchStub = vi.fn();
    const sender = createWebPushSender({
      vapid: { publicKey: TEST_VAPID.publicKey, privateKey: d, subject: "mailto:ops@example.org" },
      log: createJsonLogger({
        level: "debug",
        now: () => NOW,
        sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
      now: () => NOW,
      fetch: fetchStub,
    });
    await expect(sender.verifyKeys()).rejects.toThrow(VapidKeyError);
    for (let i = 0; i < 2; i++) {
      expect(await sender.send((await target()).target, MESSAGE)).toEqual({
        kind: "failed",
        errorClass: "VapidKeyError",
      });
    }
    expect(fetchStub).not.toHaveBeenCalled();
    expect(lines.filter((line) => line["alert"] === "push_keys_invalid")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(d);
  });
});

describe("corePushSender", () => {
  const log = createJsonLogger({ level: "error", now: () => NOW, sink: () => undefined });

  it("is disabled without VAPID configuration", () => {
    const config = parseConfig(PROD_ENV, { runtime: "node", installedGames: [] });
    expect(corePushSender(config, log, () => NOW).enabled).toBe(false);
  });

  it("is Web Push with it", async () => {
    const config = parseConfig(
      {
        ...PROD_ENV,
        VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
        VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
        VAPID_SUBJECT: "mailto:ops@example.org",
      },
      { runtime: "node", installedGames: [] },
    );
    const sender = corePushSender(config, log, () => NOW);
    expect(sender.enabled).toBe(true);
    await expect(sender.verifyKeys()).resolves.toBeUndefined();
  });
});
