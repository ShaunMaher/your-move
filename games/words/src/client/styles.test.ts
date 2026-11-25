// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { PAIRS, STYLE_TEXT, TOKENS } from "./styles.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.head.innerHTML = "";
});

describe("installStyles", () => {
  it("adopts a constructable stylesheet, which a strict CSP allows, once", async () => {
    const replaceSync = vi.fn();
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync(text: string): void {
          replaceSync(text);
        }
      },
    );
    Object.defineProperty(document, "adoptedStyleSheets", {
      value: [],
      writable: true,
      configurable: true,
    });
    const { installStyles } = await import("./styles.js");
    expect(installStyles()).toBe(true);
    expect(installStyles()).toBe(true);
    expect(document.adoptedStyleSheets).toHaveLength(1);
    expect(replaceSync).toHaveBeenCalledTimes(1);
    expect(String(replaceSync.mock.calls[0]?.[0])).toContain(".ym-w-frame");
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("reports a browser without constructable stylesheets, and adds no style element", async () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    const { installStyles } = await import("./styles.js");
    expect(installStyles()).toBe(false);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("reports a stylesheet the browser refuses", async () => {
    vi.stubGlobal(
      "CSSStyleSheet",
      class {
        replaceSync(): void {
          throw new Error("refused");
        }
      },
    );
    const { installStyles } = await import("./styles.js");
    expect(installStyles()).toBe(false);
  });
});

/** WCAG 2.2 relative luminance and contrast ratio of two #rrggbb colours. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("the board's colours", () => {
  it("are all #rrggbb and all used by the stylesheet", () => {
    for (const [name, value] of Object.entries(TOKENS)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/u);
      expect(STYLE_TEXT).toContain(`--w-${name}:`);
    }
  });

  it.each(PAIRS.map((pair) => [pair.what, pair] as const))(
    "keep %s readable (WCAG contrast)",
    (_what, pair) => {
      const ratio = contrast(TOKENS[pair.fg], TOKENS[pair.bg]);
      expect(ratio).toBeGreaterThanOrEqual(pair.kind === "text" ? 4.5 : 3);
    },
  );

  it("pair every foreground and background the premium and tile rules use", () => {
    const pairs = new Set(PAIRS.map((pair) => `${pair.fg}/${pair.bg}`));
    for (const premium of ["dl", "tl", "dw", "tw"]) {
      expect(pairs.has(`${premium}-ink/${premium}-bg`)).toBe(true);
    }
    expect(pairs.has("tile-ink/tile")).toBe(true);
    expect(pairs.has("blank-ink/blank-tile")).toBe(true);
  });

  it("don't rely on colour alone to mark a premium square", () => {
    expect(STYLE_TEXT).toMatch(/data-premium="DW"[^}]*repeating-linear-gradient/u);
    expect(STYLE_TEXT).toMatch(/data-premium="TW"[^}]*repeating-linear-gradient/u);
    expect(STYLE_TEXT).toMatch(/data-premium="DL"[^}]*inset 0 0 0 2px/u);
    expect(STYLE_TEXT).toMatch(/data-premium="TL"[^}]*inset 0 0 0 2px/u);
  });
});
