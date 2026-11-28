// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOOKS } from "./art.js";
import { DARK, HALO, LIGHT, PAIRS, STYLE_TEXT, type Tokens } from "./styles.js";

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
    expect(String(replaceSync.mock.calls[0]?.[0])).toContain(".ym-p-grid");
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
        expect(STYLE_TEXT).toContain(`--p-${name}:`);
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

    it("shows every marker against the squares and tiles: one of its two outlines always stands out", () => {
      for (const ground of [tokens.cell, tokens.tile, tokens.paper, tokens.path]) {
        const best = Math.max(contrast(HALO.dark, ground), contrast(HALO.light, ground));
        expect(best).toBeGreaterThanOrEqual(3);
      }
    });
  });

  it("keeps every marker's colour apart from its dark outline, and every shape distinct", () => {
    for (const look of LOOKS) {
      expect(contrast(look.fill, HALO.dark)).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(LOOKS.map((look) => look.shape)).size).toBe(LOOKS.length);
    expect(new Set(LOOKS.map((look) => look.d)).size).toBe(LOOKS.length);
    expect(new Set(LOOKS.map((look) => look.fill)).size).toBe(LOOKS.length);
    expect(LOOKS).toHaveLength(8);
  });

  it("follows the theme the way the shell does (07 §5)", () => {
    expect(STYLE_TEXT).toContain(':root[data-theme="dark"] .ym-p {');
    expect(STYLE_TEXT).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \.ym-p \{/u,
    );
    // Dark is the second declaration of every token: the same names, the dark values.
    for (const name of Object.keys(DARK)) {
      const dark = DARK[name as keyof Tokens];
      expect(STYLE_TEXT.split(`--p-${name}: ${dark};`).length - 1).toBe(2);
    }
  });

  it("doesn't rely on colour alone: dashes mark the target, a tick and a thick border the selected tile", () => {
    expect(STYLE_TEXT).toMatch(/data-target="true"\] \{[^}]*outline: 3px dashed/u);
    expect(STYLE_TEXT).toMatch(/\[aria-pressed="true"\] \{[^}]*border-width: 5px/u);
    expect(STYLE_TEXT).toContain('content: "\\2713"');
  });

  it("keeps the secondary text of the acting player's chip in the chip's own colours", () => {
    // `muted` on the chip's `ink` fails contrast; the chip is `paper` on `ink` (a pair above).
    expect(STYLE_TEXT).toContain(
      '.ym-p-players [aria-current="true"] .ym-p-detail { color: inherit; }',
    );
    expect(STYLE_TEXT).toMatch(
      /\.ym-p-players \[data-out="true"\]\[aria-current="true"\] \{ color: var\(--p-paper\)/u,
    );
  });

  it("sizes the board by the spec: squares of at most 56 pt that fit the screen", () => {
    expect(STYLE_TEXT).toMatch(/\.ym-p-stage \{[^}]*width: min\(100%, calc\(6 \* 56pt\)\)/u);
  });

  it("keeps hand tiles and buttons at 44 px or more, and 40 px or more on the smallest phones", () => {
    expect(STYLE_TEXT).toContain("--p-hand: 4.5rem");
    expect(STYLE_TEXT).toContain("@media (max-width: 359px) { .ym-p { --p-hand: 4rem; } }");
    expect(STYLE_TEXT).toMatch(
      /\.ym-p-actions button, \.ym-p-notches button \{[^}]*min-height: 2\.75rem/u,
    );
    expect(STYLE_TEXT).toMatch(/\.ym-p-notches button \{ min-height: 3rem/u);
  });

  it("has no infinite animation, which would keep the page from ever being still", () => {
    expect(STYLE_TEXT).not.toContain("animation");
  });
});
