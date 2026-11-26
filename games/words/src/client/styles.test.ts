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

  it("put every premium label on a solid chip of the pair's background, not on the stripes", () => {
    for (const premium of ["DL", "TL", "DW", "TW"]) {
      const code = premium.toLowerCase();
      expect(STYLE_TEXT).toContain(
        `.ym-w-sq[data-premium="${premium}"] .ym-w-face { background: var(--w-${code}-bg); }`,
      );
    }
    // The stripes are painted on the square, which the chip covers where the label is.
    expect(STYLE_TEXT).toMatch(/\.ym-w-face \{[^}]*padding/u);
  });

  it("keep form controls light on the paper when the shell is dark", () => {
    // The module is a light panel in either theme: the shell's dark `select` rule gave the word
    // list a dark field with the module's dark ink inherited on it, so it read black on black.
    const set = (selector: string): string[] =>
      declarations(STYLE_TEXT)
        .filter((d) => d.selector === selector)
        .map((d) => d.property);
    expect(STYLE_TEXT).toMatch(/\.ym-w \{[^}]*color-scheme: light;/u);
    expect(set(".ym-w select")).toEqual(
      expect.arrayContaining(["color", "background", "border-color"]),
    );
  });
});

/** A selector's specificity as a comparable number (ids, then classes, then elements). */
function specificity(selector: string): number {
  const plain = selector.replace(/:(?:where)\([^)]*\)/gu, "");
  const ids = (plain.match(/#[\w-]+/gu) ?? []).length;
  const pseudoElements = (plain.match(/::[\w-]+/gu) ?? []).length;
  const classes = (plain.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):[\w-]+/gu) ?? []).length;
  const names = (plain.replace(/\[[^\]]*\]/gu, "").match(/(?:^|[\s>+~])[a-z][\w-]*/gu) ?? [])
    .length;
  return ids * 10_000 + classes * 100 + names + pseudoElements;
}

interface Declared {
  readonly selector: string;
  readonly property: string;
  readonly order: number;
}

/** Every selector and property of the innermost rules, in source order. */
function declarations(css: string): Declared[] {
  const found: Declared[] = [];
  let order = 0;
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selectors = (rule[1] ?? "").split(",").map((part) => part.trim());
    const properties = (rule[2] ?? "").split(";").map((part) => part.split(":")[0]?.trim() ?? "");
    for (const selector of selectors)
      for (const property of properties)
        if (property !== "") found.push({ selector, property, order: order++ });
  }
  return found;
}

/**
 * The text-style declarations of a square or tile selector that the sheet's `.ym-w button` reset
 * overrides: the reset sets `font` and `color`, so a rule that sets them for a button has to
 * outrank it (or tie and come later), or it silently loses (A3-P-3, A3-P2-2).
 */
function outranked(css: string): string[] {
  const all = declarations(css);
  const reset = all.find((d) => d.selector === ".ym-w button" && d.property === "color");
  if (reset === undefined) throw new Error("the button reset is gone");
  const floor = specificity(reset.selector);
  return all
    .filter(
      (d) =>
        /\.ym-w-(?:sq|tile)\b/u.test(d.selector) &&
        /^(?:color|font|font-[a-z]+)$/u.test(d.property) &&
        (specificity(d.selector) < floor ||
          (specificity(d.selector) === floor && d.order < reset.order)),
    )
    .map((d) => `${d.selector} { ${d.property} }`);
}

describe("the stylesheet's specificity", () => {
  it("lets every colour and font rule of a square or tile beat the button reset", () => {
    expect(outranked(STYLE_TEXT)).toEqual([]);
  });

  it("notices a rule the reset would override", () => {
    const css = `.ym-w button { font: inherit; color: inherit; }
      .ym-w-tile { color: red; }
      .ym-w-sq { font-size: 9px; }
      .ym-w .ym-w-tile { color: white; }`;
    expect(outranked(css)).toEqual([".ym-w-tile { color }", ".ym-w-sq { font-size }"]);
  });

  it("counts attributes and pseudo-classes as classes, and ignores a pseudo-element's weight", () => {
    expect(specificity(".ym-w button")).toBe(101);
    expect(specificity('.ym-w-sq[data-premium="DL"]')).toBe(200);
    expect(specificity(".ym-w .ym-w-tile::after")).toBe(201);
    expect(specificity(".ym-w .ym-w-sq:focus-visible")).toBe(300);
  });
});
