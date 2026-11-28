// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { DARK, FLIP_MS, LIGHT, PAIRS, STYLE_TEXT, type Tokens } from "./styles.js";

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
    expect(String(replaceSync.mock.calls[0]?.[0])).toContain(".ym-pr-board");
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

const THEMES: readonly (readonly [string, Tokens])[] = [
  ["light", LIGHT],
  ["dark", DARK],
];

describe("the board's colours", () => {
  it("are all #rrggbb, one set per theme, and all used by the stylesheet", () => {
    expect(Object.keys(DARK)).toEqual(Object.keys(LIGHT));
    for (const [, tokens] of THEMES) {
      for (const [name, value] of Object.entries(tokens)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/u);
        expect(STYLE_TEXT).toContain(`--pr-${name}:`);
      }
    }
  });

  describe.each(THEMES)("in the %s theme", (_theme, tokens) => {
    it.each(PAIRS.map((pair) => [pair.what, pair] as const))(
      "keeps %s readable (WCAG contrast)",
      (_what, pair) => {
        const ratio = contrast(tokens[pair.fg], tokens[pair.bg]);
        expect(ratio).toBeGreaterThanOrEqual(pair.kind === "text" ? 4.5 : 3);
      },
    );
  });

  it("keeps the ink tokens readable on the shell's own page colours, which the board sits on", () => {
    // apps/web/src/styles.css: --color-bg in each theme.
    const shell = { light: "#f7f7f5", dark: "#151515" };
    for (const [theme, tokens] of [
      ["light", LIGHT],
      ["dark", DARK],
    ] as const) {
      for (const name of ["ink", "muted", "bad", "ok"] as const) {
        expect(contrast(tokens[name], shell[theme])).toBeGreaterThanOrEqual(4.5);
      }
      for (const name of ["accent", "back", "muted"] as const) {
        expect(contrast(tokens[name], shell[theme])).toBeGreaterThanOrEqual(3);
      }
    }
    expect(STYLE_TEXT).toMatch(/\.ym-pr \{[^}]*background: transparent/u);
  });

  it("follows the theme the way the shell does (07 §5)", () => {
    expect(STYLE_TEXT).toContain(':root[data-theme="dark"] .ym-pr {');
    expect(STYLE_TEXT).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \.ym-pr \{/u,
    );
    // Dark is the second declaration of every token: the same names, the dark values.
    for (const name of Object.keys(DARK)) {
      const dark = DARK[name as keyof Tokens];
      expect(STYLE_TEXT.split(`--pr-${name}: ${dark};`).length - 1).toBe(2);
    }
  });
});

describe("the board's layout", () => {
  it("sizes cards to at most 88 px with 4 px gaps, in at most 6 columns (pairs §9)", () => {
    expect(STYLE_TEXT).toMatch(/\.ym-pr-row \{[^}]*repeat\(var\(--pr-cols\), minmax\(0, 88px\)\)/u);
    expect(STYLE_TEXT).toMatch(/\.ym-pr-row \{[^}]*gap: 4px/u);
    expect(STYLE_TEXT).toMatch(/\.ym-pr-cell \{[^}]*aspect-ratio: 1/u);
    for (const columns of [4, 5, 6]) {
      expect(STYLE_TEXT).toContain(
        `.ym-pr-board[data-cols="${String(columns)}"] { --pr-cols: ${String(columns)}; }`,
      );
    }
    expect(STYLE_TEXT).not.toContain('data-cols="7"');
  });

  it("puts the players in two columns on narrow screens and one wrapped line from 480 px", () => {
    expect(STYLE_TEXT).toMatch(
      /\.ym-pr-players \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u,
    );
    expect(STYLE_TEXT).toMatch(
      /@media \(min-width: 480px\) \{ \.ym-pr-players \{ display: flex; flex-wrap: wrap;/u,
    );
  });

  it("doesn't rely on colour alone: a solid outline for the first card, a dashed one for the missed pair", () => {
    expect(STYLE_TEXT).toMatch(/data-state="up"\] \{ outline: 3px solid/u);
    expect(STYLE_TEXT).toMatch(/data-state="missed"\] \{ outline: 3px dashed/u);
  });

  it("flips for about 250 ms and not at all with reduced motion", () => {
    expect(FLIP_MS).toBe(250);
    expect(STYLE_TEXT).toContain("animation: ym-pr-in 250ms");
    expect(STYLE_TEXT).toContain("animation: ym-pr-out 250ms");
    expect(STYLE_TEXT).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.ym-pr-flip-in, \.ym-pr-flip-out \{ animation: none; \}/u,
    );
    // Nothing runs for ever.
    expect(STYLE_TEXT).not.toContain("infinite");
  });
});
