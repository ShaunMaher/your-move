// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type BuildInfo, renderWorker } from "../vite-plugin/service-worker.js";

const ORIGIN = "https://games.example";
const BUILD: BuildInfo = {
  version: "abc",
  precache: ["/", "/index.html", "/assets/app-1.js"],
  serverPaths: ["/api/*", "/manifest.webmanifest", "/__dev/*"],
};
const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");

type Listener = (event: unknown) => void;

/** A Cache Storage that remembers what was stored under which name. */
function fakeCaches(initial: Record<string, string[]> = {}) {
  const stores = new Map<string, Map<string, Response>>(
    Object.entries(initial).map(([name, paths]) => [
      name,
      new Map(paths.map((path) => [path, new Response(`old ${path}`)])),
    ]),
  );
  const key = (request: Request | string) =>
    typeof request === "string" ? request : new URL(request.url).pathname;
  const open = (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return Promise.resolve({
      addAll: (requests: Request[]) => {
        for (const request of requests) {
          store.set(new URL(request.url, ORIGIN).pathname, new Response(`new ${request.url}`));
        }
        return Promise.resolve();
      },
    });
  };
  return {
    stores,
    open,
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
    match: (request: Request | string, options?: { cacheName?: string }) => {
      const hit = stores.get(options?.cacheName ?? "")?.get(key(request));
      return Promise.resolve(hit?.clone());
    },
  };
}

/** Runs the worker's source, as the build assembles it, against stubs of its globals. */
function load(options: { caches?: ReturnType<typeof fakeCaches>; fetch?: typeof fetch } = {}) {
  const listeners = new Map<string, Listener>();
  const caches = options.caches ?? fakeCaches();
  const fetchStub = options.fetch ?? vi.fn(() => Promise.resolve(new Response("network")));
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    clients: { claim: vi.fn(() => Promise.resolve()) },
    skipWaiting: vi.fn(() => Promise.resolve()),
  };
  vm.runInNewContext(renderWorker(BUILD, template), {
    self,
    caches,
    fetch: fetchStub,
    // A worker's relative URLs resolve against its own; Node's need to be told.
    Request: class extends Request {
      constructor(input: string, init?: RequestInit) {
        super(new URL(input, ORIGIN), init);
      }
    },
    Response,
    URL,
    setTimeout,
  });
  return { listeners, caches, self, fetch: fetchStub };
}

/** Delivers a fetch event; resolves to the response the worker gave, or null if it passed. */
function dispatch(
  worker: ReturnType<typeof load>,
  url: string,
  init: { method?: string; mode?: string } = {},
): Promise<Response | null> {
  const given: { answer: Promise<Response> | null } = { answer: null };
  const request = {
    url: url.startsWith("https://") ? url : `${ORIGIN}${url}`,
    method: init.method ?? "GET",
    mode: init.mode ?? "cors",
  };
  worker.listeners.get("fetch")?.({
    request,
    respondWith: (answer: Promise<Response>) => {
      given.answer = answer;
    },
  });
  return Promise.resolve(given.answer);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("install", () => {
  it("precaches exactly BUILD.precache, bypassing the HTTP cache", async () => {
    const worker = load();
    const waits: Promise<unknown>[] = [];
    worker.listeners.get("install")?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...(worker.caches.stores.get("shell-abc")?.keys() ?? [])].sort()).toEqual(
      [...BUILD.precache].sort(),
    );
  });
});

describe("activate", () => {
  it("deletes every other cache but the page's word lists, and takes over the open pages", async () => {
    const caches = fakeCaches({
      "shell-old": ["/"],
      "shell-abc": ["/"],
      "dictionaries-v1": ["/assets/dictionaries/enable-v1.0123456789abcdef.txt"],
      other: [],
    });
    const worker = load({ caches });
    const waits: Promise<unknown>[] = [];
    worker.listeners.get("activate")?.({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...caches.stores.keys()].sort()).toEqual(["dictionaries-v1", "shell-abc"]);
    expect(worker.self.clients.claim).toHaveBeenCalledOnce();
  });
});

describe("message", () => {
  it("skips waiting only when asked to", () => {
    const worker = load();
    worker.listeners.get("message")?.({ data: "something else" });
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
    worker.listeners.get("message")?.({ data: "SKIP_WAITING" });
    expect(worker.self.skipWaiting).toHaveBeenCalledOnce();
  });
});

describe("fetch ignores what is not the shell's", () => {
  it.each([
    ["a POST", "/assets/app-1.js", { method: "POST" }],
    ["an API path", "/api/v1/me", {}],
    ["an API navigation", "/api/v1/email/unsubscribe", { mode: "navigate" }],
    ["the API root", "/api", {}],
    ["the dev emails", "/__dev/emails", {}],
    ["the manifest", "/manifest.webmanifest", {}],
  ])("%s", async (_name, path, init) => {
    const worker = load();
    expect(await dispatch(worker, path, init)).toBeNull();
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("another origin", async () => {
    const worker = load();
    expect(await dispatch(worker, "https://elsewhere.example/assets/app-1.js")).toBeNull();
  });

  it("but not a path that only starts like a server path", async () => {
    const worker = load();
    expect(await dispatch(worker, "/apiary", { mode: "navigate" })).not.toBeNull();
  });
});

describe("assets", () => {
  it("come from the cache, else the network", async () => {
    const caches = fakeCaches({ "shell-abc": ["/assets/app-1.js"] });
    const worker = load({ caches });
    expect(await (await dispatch(worker, "/assets/app-1.js"))?.text()).toBe("old /assets/app-1.js");
    expect(await (await dispatch(worker, "/assets/other.js"))?.text()).toBe("network");
  });
});

describe("navigations", () => {
  const shellCache = () => fakeCaches({ "shell-abc": ["/"] });

  it("take the network's answer", async () => {
    const worker = load({ caches: shellCache() });
    expect(await (await dispatch(worker, "/settings", { mode: "navigate" }))?.text()).toBe(
      "network",
    );
  });

  it("fall back to the shell when the network fails", async () => {
    const worker = load({ caches: shellCache(), fetch: () => Promise.reject(new TypeError("x")) });
    expect(await (await dispatch(worker, "/settings", { mode: "navigate" }))?.text()).toBe("old /");
  });

  it("fall back to the shell when the network is slower than the timeout", async () => {
    const worker = load({ caches: shellCache(), fetch: () => new Promise(() => undefined) });
    const answer = dispatch(worker, "/settings", { mode: "navigate" });
    await vi.advanceTimersByTimeAsync(3999);
    let settled = false;
    void answer.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await answer)?.text()).toBe("old /");
  });

  it("wait on a slow network when there is no shell to show", async () => {
    let answerLate: (response: Response) => void = () => undefined;
    const worker = load({
      fetch: () =>
        new Promise<Response>((resolve) => {
          answerLate = resolve;
        }),
    });
    const answer = dispatch(worker, "/", { mode: "navigate" });
    await vi.advanceTimersByTimeAsync(10_000);
    answerLate(new Response("late"));
    expect(await (await answer)?.text()).toBe("late");
  });

  it("fail cleanly with no network and no shell", async () => {
    const worker = load({ fetch: () => Promise.reject(new TypeError("x")) });
    const response = await dispatch(worker, "/", { mode: "navigate" });
    expect(response?.type).toBe("error");
  });
});
