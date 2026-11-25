import { describe, expect, it, vi } from "vitest";

import { type UpdateWatch, watchForUpdates } from "./sw-register.js";

/** A just-enough fake of the service worker objects. */
function fakes(options: { controlled: boolean; waiting?: boolean }) {
  const posted: unknown[] = [];
  const worker = (state: string) => {
    const listeners: Record<string, (() => void)[]> = {};
    return {
      state,
      postMessage: (message: unknown) => posted.push(message),
      addEventListener: (type: string, listener: () => void) =>
        (listeners[type] ??= []).push(listener),
      fire(type: string) {
        for (const listener of listeners[type] ?? []) listener();
      },
    };
  };
  const registrationListeners: (() => void)[] = [];
  const installing = worker("installing");
  const registration = {
    waiting: options.waiting === true ? worker("installed") : null,
    installing: null as ReturnType<typeof worker> | null,
    addEventListener: (_type: string, listener: () => void) => registrationListeners.push(listener),
  };
  const containerListeners: (() => void)[] = [];
  const container = {
    controller: options.controlled ? {} : null,
    addEventListener: (_type: string, listener: () => void) => containerListeners.push(listener),
  };
  return {
    posted,
    installing,
    registration,
    container,
    foundUpdate() {
      registration.installing = installing;
      for (const listener of registrationListeners) listener();
    },
    takeOver() {
      for (const listener of containerListeners) listener();
    },
  };
}

function watch(f: ReturnType<typeof fakes>) {
  const onUpdate = vi.fn<(update: UpdateWatch) => void>();
  const reload = vi.fn();
  watchForUpdates(
    f.container as unknown as ServiceWorkerContainer,
    f.registration as unknown as ServiceWorkerRegistration,
    onUpdate,
    reload,
  );
  return { onUpdate, reload };
}

describe("watchForUpdates", () => {
  it("offers an update once a new worker has installed under a controlling one", () => {
    const f = fakes({ controlled: true });
    const { onUpdate, reload } = watch(f);
    f.foundUpdate();
    f.installing.state = "installed";
    f.installing.fire("statechange");
    expect(onUpdate).toHaveBeenCalledOnce();
    onUpdate.mock.calls[0]?.[0].apply();
    expect(f.posted).toEqual(["SKIP_WAITING"]);
    f.takeOver();
    f.takeOver();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload when a worker takes over without being asked to (the first install)", () => {
    const f = fakes({ controlled: false });
    const { reload } = watch(f);
    f.takeOver();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not call the very first install an update", () => {
    const f = fakes({ controlled: false });
    const { onUpdate } = watch(f);
    f.foundUpdate();
    f.installing.state = "installed";
    f.installing.fire("statechange");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("offers a worker that was already waiting", () => {
    const { onUpdate } = watch(fakes({ controlled: true, waiting: true }));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("ignores states other than installed", () => {
    const f = fakes({ controlled: true });
    const { onUpdate } = watch(f);
    f.foundUpdate();
    f.installing.fire("statechange");
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
