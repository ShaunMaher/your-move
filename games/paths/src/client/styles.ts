/**
 * The board's stylesheet, as text. A client module is plain JavaScript (02 §3, §7.1.1) and the
 * page's CSP allows no inline styles (08 §3), so the sheet is installed as a constructable
 * stylesheet, which that policy doesn't restrict. A browser without them (07 §1) is told to
 * update; there is no `<style>` fallback.
 *
 * The look is original (07 §5): cool paper and ink, deep teal tiles with cream paths, markers in
 * the Okabe–Ito colours with a shape each. It follows the theme like the shell does: light by
 * default, dark under `prefers-color-scheme: dark` unless the person chose light, and dark when
 * they chose dark. Colour is never the only signal: markers differ by shape, the target square is
 * outlined with dashes, the selected tile has a thicker border and a tick, a tile that would put
 * your marker out says so in words. `styles.test.ts` checks the contrast of each pair in `PAIRS`
 * in both themes.
 */

/** Every themed colour of the board. */
export interface Tokens {
  readonly paper: string;
  readonly ink: string;
  readonly muted: string;
  readonly line: string;
  readonly cell: string;
  readonly dot: string;
  readonly accent: string;
  readonly bad: string;
  readonly ok: string;
  readonly tile: string;
  readonly path: string;
  readonly casing: string;
  readonly "primary-bg": string;
  readonly "primary-ink": string;
  readonly "turn-bg": string;
  readonly "turn-ink": string;
}

type Token = keyof Tokens;

export const LIGHT: Tokens = {
  paper: "#f6f8fa",
  ink: "#1b2230",
  muted: "#465163",
  line: "#aab5c3",
  cell: "#dfe6ee",
  dot: "#6d7b90",
  accent: "#92400e",
  bad: "#a31d1d",
  ok: "#1c6b3a",
  tile: "#1f5c66",
  path: "#f4ecd8",
  casing: "#0d2b31",
  "primary-bg": "#1b2230",
  "primary-ink": "#f6f8fa",
  "turn-bg": "#92400e",
  "turn-ink": "#ffffff",
};

export const DARK: Tokens = {
  paper: "#12161c",
  ink: "#e8edf3",
  muted: "#aab5c3",
  line: "#3b4656",
  cell: "#232b36",
  dot: "#8896ab",
  accent: "#f4b942",
  bad: "#ff9b95",
  ok: "#7fd49b",
  tile: "#1d5a66",
  path: "#efe6cf",
  casing: "#071a1e",
  "primary-bg": "#e8edf3",
  "primary-ink": "#12161c",
  "turn-bg": "#f4b942",
  "turn-ink": "#1b1405",
};

/** The marker outlines, the same in both themes: a dark ring and a light ring inside it. */
export const HALO = { dark: "#10151d", light: "#ffffff" } as const;

/** A text or non-text colour pair that must stay readable (WCAG 2.2 §1.4.3, §1.4.11). */
export interface Pair {
  readonly what: string;
  readonly fg: Token;
  readonly bg: Token;
  /** Text needs 4.5:1; borders, rings and other parts of the interface 3:1. */
  readonly kind: "text" | "non-text";
}

export const PAIRS: readonly Pair[] = [
  { what: "text on the page", fg: "ink", bg: "paper", kind: "text" },
  { what: "secondary text on the page", fg: "muted", bg: "paper", kind: "text" },
  { what: "error text", fg: "bad", bg: "paper", kind: "text" },
  { what: "confirmation text", fg: "ok", bg: "paper", kind: "text" },
  { what: "the acting player's chip", fg: "paper", bg: "ink", kind: "text" },
  { what: "primary button label", fg: "primary-ink", bg: "primary-bg", kind: "text" },
  { what: "your-turn line", fg: "turn-ink", bg: "turn-bg", kind: "text" },
  { what: "your-turn line against the page", fg: "turn-bg", bg: "paper", kind: "non-text" },
  { what: "button and tile borders", fg: "muted", bg: "paper", kind: "non-text" },
  { what: "focus ring on the page", fg: "accent", bg: "paper", kind: "non-text" },
  { what: "focus and target ring on an empty square", fg: "accent", bg: "cell", kind: "non-text" },
  { what: "notch dots on an empty square", fg: "dot", bg: "cell", kind: "non-text" },
  { what: "a tile's paths on its body", fg: "path", bg: "tile", kind: "non-text" },
  { what: "a path's casing against the path", fg: "casing", bg: "path", kind: "non-text" },
  { what: "board frame against the page", fg: "ink", bg: "paper", kind: "non-text" },
];

const vars = (tokens: Tokens): string =>
  (Object.keys(tokens) as Token[]).map((name) => `--p-${name}: ${tokens[name]};`).join(" ");

const CSS = `
.ym-p { ${vars(LIGHT)} --p-halo-dark: ${HALO.dark}; --p-halo-light: ${HALO.light};
  --p-hand: 4.5rem; color-scheme: light;
  color: var(--p-ink); background: transparent; display: flex; flex-direction: column;
  gap: 0.5rem; max-width: 34rem; margin: 0 auto; padding: 0.5rem 0 calc(0.5rem + env(safe-area-inset-bottom));
  font-family: system-ui, -apple-system, sans-serif; font-size: 1rem; box-sizing: border-box; }
:root[data-theme="dark"] .ym-p { ${vars(DARK)} color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ym-p { ${vars(DARK)} color-scheme: dark; }
}
.ym-p *, .ym-p *::before, .ym-p *::after { box-sizing: border-box; }
.ym-p :where(button) { font: inherit; color: inherit; cursor: pointer; }
.ym-p :where(button:disabled) { cursor: default; opacity: 0.55; }
.ym-p :where(select, input) { color: var(--p-ink); background: var(--p-paper); }
.ym-p :focus-visible { outline: 3px solid var(--p-accent); outline-offset: 2px; }
.ym-p-vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }
.ym-p-players { display: flex; flex-wrap: wrap; gap: 0.25rem 0.5rem; margin: 0; padding: 0; list-style: none; }
.ym-p-players li { display: inline-flex; align-items: center; gap: 0.35rem; font-weight: 600;
  padding: 0.1rem 0.6rem 0.1rem 0.3rem; border: 2px solid transparent; border-radius: 999px; }
.ym-p-players [aria-current="true"] { background: var(--p-ink); color: var(--p-paper);
  border-color: var(--p-ink); text-decoration: underline; text-underline-offset: 0.25em; }
.ym-p-players [aria-current="true"] .ym-p-detail { color: inherit; }
.ym-p-players [data-out="true"] { font-style: italic; font-weight: 400; color: var(--p-muted); }
.ym-p-players [data-out="true"][aria-current="true"] { color: var(--p-paper); }
.ym-p-icon { flex: none; width: 1.5rem; height: 1.5rem; }
.ym-p-turn { margin: 0; padding: 0.35rem 0.75rem; border: 2px solid var(--p-line);
  border-radius: 8px; font-weight: 600; color: var(--p-muted); }
.ym-p-turn[data-yours="true"] { background: var(--p-turn-bg); color: var(--p-turn-ink);
  border-color: var(--p-turn-bg); font-weight: 800; font-size: 1.125rem; }
.ym-p-meta { margin: 0; color: var(--p-muted); font-size: 0.875rem; }
.ym-p-stage { position: relative; width: min(100%, calc(6 * 56pt)); margin: 0 auto; }
.ym-p-grid { display: grid; grid-template-columns: repeat(6, 1fr); aspect-ratio: 1; width: 100%;
  box-shadow: 0 0 0 2px var(--p-ink); background: var(--p-cell); }
.ym-p .ym-p-sq { position: relative; display: block; min-width: 0; min-height: 0; padding: 0;
  border: 0; border-radius: 0; background: var(--p-cell); color: inherit; overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--p-line); }
.ym-p-sq svg { display: block; width: 100%; height: 100%; }
.ym-p-dot { fill: var(--p-dot); }
.ym-p-sq[data-target="true"] { outline: 3px dashed var(--p-accent); outline-offset: -3px; }
.ym-p-sq[data-ghost="true"] .ym-p-tile { opacity: 0.8; }
.ym-p-sq[data-pickable="true"] { box-shadow: inset 0 0 0 2px var(--p-accent); }
.ym-p-sq[data-selected="true"] { outline: 4px solid var(--p-accent); outline-offset: -4px; }
.ym-p .ym-p-sq:focus-visible { outline: 4px double var(--p-accent); outline-offset: -4px; }
.ym-p-tile-body { fill: var(--p-tile); }
.ym-p-path-casing { fill: none; stroke: var(--p-casing); stroke-width: 15; }
.ym-p-path { fill: none; stroke: var(--p-path); stroke-width: 9; }
.ym-p-over { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible;
  pointer-events: none; }
.ym-p-halo-dark { fill: none; stroke: var(--p-halo-dark); stroke-linejoin: round; }
.ym-p-halo-light { fill: none; stroke: var(--p-halo-light); stroke-linejoin: round; }
.ym-p-trace-casing { fill: none; stroke: var(--p-halo-dark); stroke-width: 11; stroke-linecap: round;
  stroke-linejoin: round; }
.ym-p-trace-halo { fill: none; stroke: var(--p-halo-light); stroke-width: 7.5; stroke-linecap: round;
  stroke-linejoin: round; }
.ym-p-trace { fill: none; stroke-width: 4.5; stroke-linecap: round; stroke-linejoin: round; }
.ym-p-crash { fill: none; stroke: var(--p-halo-dark); stroke-width: 6; stroke-linecap: round; }
.ym-p-crash-light { fill: none; stroke: var(--p-halo-light); stroke-width: 3; stroke-linecap: round; }
.ym-p-notch-dot { fill: none; stroke: var(--p-accent); stroke-width: 3; }
.ym-p-notch-dot[data-free="true"] { fill: var(--p-halo-light); stroke: var(--p-halo-dark); }
.ym-p-notch-dot[data-aim="true"] { fill: var(--p-accent); stroke: var(--p-halo-dark); stroke-width: 4; }
.ym-p-status { min-height: 3.25rem; margin: 0; display: flex; flex-direction: column;
  justify-content: center; font-size: 0.95rem; }
.ym-p-status [data-tone="bad"] { color: var(--p-bad); font-weight: 700; }
.ym-p-status [data-tone="ok"] { color: var(--p-ok); }
.ym-p-hand { display: flex; gap: 0.5rem; justify-content: center; margin: 0; padding: 0; border: 0; }
.ym-p-pick { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; }
.ym-p .ym-p-hand-tile { position: relative; width: var(--p-hand); height: var(--p-hand); padding: 0;
  border: 3px solid var(--p-muted); border-radius: 10px; background: var(--p-paper); overflow: hidden; }
.ym-p .ym-p-hand-tile[aria-pressed="true"] { border-width: 5px; border-color: var(--p-accent); }
.ym-p-hand-tile[aria-pressed="true"]::after { content: "\\2713"; position: absolute; top: 0; left: 0;
  width: 1.25rem; height: 1.25rem; line-height: 1.25rem; text-align: center; font-weight: 800;
  background: var(--p-accent); color: var(--p-paper); }
.ym-p-hand-tile svg { display: block; width: 100%; height: 100%; }
.ym-p-chip { font-size: 0.8rem; font-weight: 700; color: var(--p-muted); }
.ym-p-chip[data-eliminates="true"] { color: var(--p-bad); }
.ym-p-actions { display: flex; gap: 0.5rem; }
.ym-p-actions button, .ym-p-picker button { min-height: 2.75rem; min-width: 2.75rem; padding: 0 0.9rem;
  border: 2px solid var(--p-muted); border-radius: 8px; background: var(--p-paper); font-weight: 700; }
.ym-p-actions button { flex: 1 1 0; }
.ym-p-actions .ym-p-primary { flex-grow: 2; background: var(--p-primary-bg); color: var(--p-primary-ink);
  border-color: var(--p-primary-bg); }
.ym-p-picker { margin: 0; padding: 0.5rem; border: 2px solid var(--p-line); border-radius: 8px; }
.ym-p-picker legend { font-weight: 700; padding: 0 0.25rem; }
.ym-p-notches { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; margin-top: 0.25rem; }
.ym-p-notches button { min-height: 3rem; padding: 0 0.25rem; }
.ym-p-cancel { width: 100%; margin-top: 0.5rem; }
.ym-p-final { margin: 0; padding: 0.5rem 0.75rem; border: 2px solid var(--p-ink); border-radius: 8px; }
.ym-p-final h2 { margin: 0 0 0.25rem; font-size: 1.125rem; }
.ym-p-final ul { margin: 0; padding: 0; list-style: none; }
.ym-p-final li { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
.ym-p-mini { width: 2rem; height: 2rem; border: 1px solid var(--p-muted); }
.ym-p-options fieldset { margin: 0 0 1rem; padding: 0; border: 0; }
.ym-p-options legend { font-weight: 700; margin-bottom: 0.25rem; }
.ym-p-card { display: flex; gap: 0.5rem; align-items: flex-start; padding: 0.5rem; margin: 0.35rem 0;
  border: 2px solid var(--p-line); border-radius: 8px; }
.ym-p-card:has(input:checked) { border-color: var(--p-ink); }
.ym-p-card input { margin-top: 0.3rem; }
.ym-p-rules h3 { margin: 0.75rem 0 0.25rem; font-size: 1.05rem; }
.ym-p-detail { color: var(--p-muted); }
@media (max-width: 359px) { .ym-p { --p-hand: 4rem; } }
`;

/** The stylesheet text, for tests. */
export const STYLE_TEXT = CSS;

/** Whether this browser can adopt a constructable stylesheet (07 §1's baseline). */
function stylesSupported(): boolean {
  return (
    typeof document !== "undefined" &&
    "adoptedStyleSheets" in document &&
    typeof CSSStyleSheet === "function" &&
    "replaceSync" in CSSStyleSheet.prototype
  );
}

let installed = false;

/** Installs the stylesheet once per page; false when this browser can't (the board says so). */
export function installStyles(): boolean {
  if (!stylesSupported()) return false;
  if (installed) return true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    installed = true;
    return true;
  } catch {
    return false;
  }
}
