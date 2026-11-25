// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.innerHTML = "";
  Reflect.deleteProperty(document, "adoptedStyleSheets");
});

describe("installStyles", () => {
  it("adopts a constructable stylesheet, which a strict CSP allows, once", async () => {
    const replaceSync = vi.fn();
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync = replaceSync;
      },
    );
    Object.defineProperty(document, "adoptedStyleSheets", { value: [], writable: true });
    const { installStyles } = await import("./styles.js");
    installStyles();
    installStyles();
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(replaceSync).toHaveBeenCalledTimes(1);
    expect(String(replaceSync.mock.calls[0]?.[0])).toContain(".ym-w-frame");
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("falls back to a style element where constructable stylesheets don't exist", async () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const { installStyles } = await import("./styles.js");
    installStyles();
    expect(document.head.querySelector("style")?.textContent).toContain(".ym-w-tile");
  });
});
