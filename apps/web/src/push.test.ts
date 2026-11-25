/** Web Push on this device (07 §4, 06 §4; alpha A8), against a fake Push API. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dropPushSubscription,
  pushState,
  rememberPushOffered,
  resyncPush,
  shouldOfferPush,
  turnOffPush,
  turnOnPush,
} from "./push.js";
import { fakeApi, fakePush, problem, PUSH_KEY, removeFakePush } from "./test-support.js";

const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const OTHER_KEY = `${PUSH_KEY.slice(0, -2)}AA`;

const saved = () =>
  fakeApi({ "POST /api/v1/push/subscriptions": new Response(null, { status: 204 }) });

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  removeFakePush();
  vi.restoreAllMocks();
});

describe("pushState", () => {
  it("is no-server-key when the instance has no VAPID key", async () => {
    fakePush();
    expect(await pushState(undefined)).toBe("no-server-key");
  });

  it("is unsupported without the Push API, or without a service worker", async () => {
    expect(await pushState(PUSH_KEY)).toBe("unsupported");
    fakePush({ registered: false });
    expect(await pushState(PUSH_KEY)).toBe("unsupported");
  });

  it("is needs-install in iOS Safari outside the Home Screen", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(SAFARI_IPHONE);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(await pushState(PUSH_KEY)).toBe("needs-install");
  });

  it.each([
    ["denied", { permission: "denied" as const }],
    ["off", {}],
    ["off", { permission: "granted" as const }],
    ["on", { permission: "granted" as const, subscribedWith: PUSH_KEY }],
  ])("is %s", async (expected, options) => {
    fakePush(options);
    expect(await pushState(PUSH_KEY)).toBe(expected);
  });
});

describe("turnOnPush", () => {
  it("asks for permission before awaiting anything, then subscribes and saves", async () => {
    const device = fakePush();
    const { api, calls } = saved();
    const done = turnOnPush(api, PUSH_KEY);
    // Synchronously, inside the tap.
    expect(device.requestPermission).toHaveBeenCalledOnce();
    expect(await done).toBe("on");
    const init = device.pushManager.subscribe.mock.calls[0]?.[0];
    expect(init?.userVisibleOnly).toBe(true);
    expect([...new Uint8Array(init?.applicationServerKey ?? [])]).toHaveLength(65);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/push/subscriptions",
        search: "",
        body: { endpoint: device.state.subscription?.endpoint, keys: { p256dh: "p", auth: "a" } },
      },
    ]);
  });

  it.each([
    ["denied", "denied" as const],
    ["off", "default" as const],
  ])(
    "is %s when permission is refused or dismissed, and subscribes nothing",
    async (outcome, answer) => {
      const device = fakePush({ answer });
      const { api, calls } = saved();
      expect(await turnOnPush(api, PUSH_KEY)).toBe(outcome);
      expect(device.pushManager.subscribe).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["failed", problem(500, "INTERNAL")],
    ["unauthenticated", problem(401, "UNAUTHENTICATED")],
    ["offline", new TypeError("offline")],
  ])("undoes the subscription when the server doesn't save it: %s", async (outcome, answer) => {
    const device = fakePush();
    const { api } = fakeApi({ "POST /api/v1/push/subscriptions": answer });
    expect(await turnOnPush(api, PUSH_KEY)).toBe(outcome);
    expect(device.state.subscription).toBeNull();
  });
});

describe("turnOffPush", () => {
  it("removes the subscription from the server, then from the device", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    const endpoint = device.state.subscription?.endpoint;
    const { api, calls } = fakeApi({
      "DELETE /api/v1/push/subscriptions": new Response(null, { status: 204 }),
    });
    expect(await turnOffPush(api)).toBe("off");
    expect(calls.map((call) => [call.method, call.body])).toEqual([["DELETE", { endpoint }]]);
    expect(device.state.subscription).toBeNull();
  });

  it("keeps the subscription when the server couldn't be told", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    const { api } = fakeApi({ "DELETE /api/v1/push/subscriptions": new TypeError("offline") });
    expect(await turnOffPush(api)).toBe("offline");
    expect(device.state.subscription).not.toBeNull();
  });
});

describe("resyncPush (at launch)", () => {
  it("saves an existing subscription again", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    const { api, calls } = saved();
    await resyncPush(api, PUSH_KEY);
    expect(calls.map((call) => call.body)).toEqual([
      { endpoint: device.state.subscription?.endpoint, keys: { p256dh: "p", auth: "a" } },
    ]);
    expect(device.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("replaces a subscription made with a VAPID key the server no longer has", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: OTHER_KEY });
    const old = device.state.subscription;
    const { api, calls } = saved();
    await resyncPush(api, PUSH_KEY);
    expect(old?.unsubscribe).toHaveBeenCalledOnce();
    expect(device.state.subscription).not.toBe(old);
    expect(calls.map((call) => (call.body as { endpoint: string }).endpoint)).toEqual([
      device.state.subscription?.endpoint,
    ]);
  });

  it("does nothing without a subscription, permission or server key", async () => {
    const { api, calls } = saved();
    fakePush({ permission: "granted" });
    await resyncPush(api, PUSH_KEY);
    removeFakePush();
    fakePush({ permission: "default", subscribedWith: PUSH_KEY });
    await resyncPush(api, PUSH_KEY);
    await resyncPush(api, undefined);
    expect(calls).toEqual([]);
  });
});

describe("dropPushSubscription (sign-out, 06 §4)", () => {
  it("unsubscribes this device", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    dropPushSubscription();
    await vi.waitFor(() => {
      expect(device.state.subscription).toBeNull();
    });
  });

  it("is harmless where push isn't supported", () => {
    expect(() => {
      dropPushSubscription();
    }).not.toThrow();
  });
});

describe("the offer after creating a game", () => {
  it("is made once per device, when push could be turned on and wasn't asked about", async () => {
    fakePush();
    expect(await shouldOfferPush(undefined)).toBe(false);
    expect(await shouldOfferPush(PUSH_KEY)).toBe(true);
    rememberPushOffered();
    expect(await shouldOfferPush(PUSH_KEY)).toBe(false);
  });

  it.each([
    ["already granted", { permission: "granted" as const }],
    ["blocked", { permission: "denied" as const }],
    ["already on", { permission: "granted" as const, subscribedWith: PUSH_KEY }],
  ])("isn't made when %s", async (_name, options) => {
    fakePush(options);
    expect(await shouldOfferPush(PUSH_KEY)).toBe(false);
  });
});
