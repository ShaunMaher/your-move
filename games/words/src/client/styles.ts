/**
 * The board's stylesheet, as text. A client module is plain JavaScript (02 §3, §7.1.1) and the
 * page's CSP allows no inline styles (08 §3), so the sheet is installed as a constructable
 * stylesheet, which that policy doesn't restrict. A browser without them (07 §1: older than
 * iOS 16.4, or not current Chrome or Firefox) is told to update; there is no `<style>` fallback.
 *
 * The look is original (07 §5): cool neutral cells, letter premiums in green and word premiums in
 * violet, flat rounded navy tiles. Colour is never the only signal: a premium square carries its
 * label (2L 3L 2W 3W), letter squares an inset border and word squares diagonal stripes, the
 * start square a diamond, a tile its letter and points, the last play a notch. A premium label
 * sits on a solid chip of the square's base colour, never on the stripes (the stripes show around
 * it), so the label's contrast is the chip's.
 */

/** Every colour of the board. `styles.test.ts` checks the contrast of each pair in `PAIRS`. */
export const TOKENS = {
  ink: "#1b2230",
  paper: "#f6f8fa",
  line: "#aab5c3",
  cell: "#dfe6ee",
  muted: "#465163",
  accent: "#92400e",
  ring: "#ffd98a",
  notch: "#f4b942",
  bad: "#a31d1d",
  ok: "#1c6b3a",
  tile: "#243b55",
  "tile-ink": "#ffffff",
  "blank-tile": "#eef2f7",
  "blank-ink": "#243b55",
  "dl-bg": "#cdebd6",
  "dl-ink": "#0f4a26",
  "dl-edge": "#2f7d4a",
  "tl-bg": "#2f7d4a",
  "tl-ink": "#ffffff",
  "dw-bg": "#e3dbf5",
  "dw-ink": "#3a1d78",
  "dw-stripe": "#7a59c4",
  "tw-bg": "#6b3fb3",
  "tw-ink": "#ffffff",
  "tw-stripe": "#9a7bd6",
} as const;

type Token = keyof typeof TOKENS;

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
  { what: "text on the rack", fg: "ink", bg: "line", kind: "text" },
  { what: "text on an empty square", fg: "ink", bg: "cell", kind: "text" },
  { what: "letter on a tile", fg: "tile-ink", bg: "tile", kind: "text" },
  { what: "letter on a blank tile", fg: "blank-ink", bg: "blank-tile", kind: "text" },
  { what: "label of a double letter square", fg: "dl-ink", bg: "dl-bg", kind: "text" },
  { what: "label of a triple letter square", fg: "tl-ink", bg: "tl-bg", kind: "text" },
  { what: "label of a double word square", fg: "dw-ink", bg: "dw-bg", kind: "text" },
  { what: "label of a triple word square", fg: "tw-ink", bg: "tw-bg", kind: "text" },
  { what: "primary button label", fg: "paper", bg: "ink", kind: "text" },
  { what: "focus ring on the page", fg: "accent", bg: "paper", kind: "non-text" },
  { what: "focus and placed ring on a square", fg: "accent", bg: "cell", kind: "non-text" },
  { what: "focus ring on the rack", fg: "accent", bg: "line", kind: "non-text" },
  { what: "placed ring on a navy tile", fg: "ring", bg: "tile", kind: "non-text" },
  { what: "last play notch on a navy tile", fg: "notch", bg: "tile", kind: "non-text" },
  {
    what: "placed ring and notch on a blank tile",
    fg: "accent",
    bg: "blank-tile",
    kind: "non-text",
  },
  { what: "focus ring on a navy tile (inner band)", fg: "ring", bg: "tile", kind: "non-text" },
  { what: "tile against an empty square", fg: "tile", bg: "cell", kind: "non-text" },
  { what: "tile against the rack", fg: "tile", bg: "line", kind: "non-text" },
  {
    what: "blank tile edge against an empty square",
    fg: "blank-ink",
    bg: "cell",
    kind: "non-text",
  },
  { what: "letter square edge", fg: "dl-edge", bg: "dl-bg", kind: "non-text" },
  { what: "word square stripe", fg: "dw-stripe", bg: "dw-bg", kind: "non-text" },
  { what: "board frame against the page", fg: "ink", bg: "paper", kind: "non-text" },
];

const VARS = (Object.keys(TOKENS) as Token[])
  .map((name) => `--w-${name}: ${TOKENS[name]};`)
  .join(" ");

const CSS = `
.ym-w { ${VARS} --w-rack: 2.75rem;
  color: var(--w-ink); background: var(--w-paper); display: flex; flex-direction: column;
  gap: 0.4rem; max-width: 34rem; font-family: system-ui, -apple-system, sans-serif; margin: 0 auto; padding: 0.5rem 0.5rem
  calc(0.5rem + env(safe-area-inset-bottom)); box-sizing: border-box; font-size: 1rem; }
.ym-w *, .ym-w *::before, .ym-w *::after { box-sizing: border-box; }
.ym-w button { font: inherit; color: inherit; cursor: pointer; }
.ym-w button:disabled { cursor: default; opacity: 0.55; }
.ym-w :focus-visible { outline: 3px solid var(--w-accent); outline-offset: 2px; }
.ym-w-scores { display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; align-items: baseline;
  margin: 0; padding: 0; list-style: none; }
.ym-w-scores li { font-weight: 600; }
.ym-w-scores [aria-current="true"] { text-decoration: underline; text-underline-offset: 0.25em; }
.ym-w-meta { margin: 0; color: var(--w-muted); font-size: 0.875rem; }
.ym-w-frame { position: relative; width: 100%; aspect-ratio: 1; overflow: hidden;
  border: 2px solid var(--w-ink); border-radius: 6px; background: var(--w-line); touch-action: none;
  container-type: size;
  user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.ym-w-grid { position: absolute; inset: 0; display: grid; gap: 1px; padding: 1px;
  transform-origin: 0 0; }
.ym-w .ym-w-sq { position: relative; display: flex; flex-direction: column; align-items: center;
  justify-content: center; min-width: 0; min-height: 0; padding: 0; border: 0; border-radius: 2px;
  background: var(--w-cell); color: var(--w-ink); font-size: 9px; font-size: max(9px, 3.2cqw);
  font-weight: 700; line-height: 1; overflow: hidden; }
.ym-w-sq[data-premium="DL"] { background: var(--w-dl-bg); color: var(--w-dl-ink);
  box-shadow: inset 0 0 0 2px var(--w-dl-edge); }
.ym-w-sq[data-premium="TL"] { background: var(--w-tl-bg); color: var(--w-tl-ink);
  box-shadow: inset 0 0 0 2px var(--w-tl-ink); }
.ym-w-sq[data-premium="DW"] { color: var(--w-dw-ink); background-color: var(--w-dw-bg);
  background-image: repeating-linear-gradient(45deg, transparent 0 3px, var(--w-dw-stripe) 3px 4px); }
.ym-w-sq[data-premium="TW"] { color: var(--w-tw-ink); background-color: var(--w-tw-bg);
  background-image: repeating-linear-gradient(45deg, transparent 0 3px, var(--w-tw-stripe) 3px 4px); }
.ym-w-sq[data-target="true"] { outline: 2px dashed var(--w-accent); outline-offset: -2px; }
.ym-w-face { display: flex; flex-direction: column; align-items: center; padding: 0.15em 0.3em;
  border-radius: 3px; }
.ym-w-sq[data-premium="DL"] .ym-w-face { background: var(--w-dl-bg); }
.ym-w-sq[data-premium="DW"] .ym-w-face { background: var(--w-dw-bg); }
.ym-w-sq[data-premium="TW"] .ym-w-face { background: var(--w-tw-bg); }
.ym-w-sq[data-premium="TL"] .ym-w-face { background: var(--w-tl-bg); }
.ym-w-start { display: block; width: 0.5em; height: 0.5em; margin: 0.2em 0 0.25em; background: currentColor;
  transform: rotate(45deg); }
.ym-w-start + span { font-size: 0.85em; }
.ym-w .ym-w-tile { display: flex; align-items: center; justify-content: center; position: relative;
  width: 100%; height: 100%; border: 0; border-radius: 28%; overflow: hidden;
  background: var(--w-tile); color: var(--w-tile-ink); font-weight: 800; font-size: 0.8rem;
  font-size: 3.8cqw; }
.ym-w .ym-w-tile small { position: absolute; right: 2px; bottom: 1px; font-size: 0.5em; font-weight: 600; }
.ym-w .ym-w-tile[data-blank="true"] { background: var(--w-blank-tile); color: var(--w-blank-ink);
  box-shadow: inset 0 0 0 2px var(--w-blank-ink); font-style: italic; }
.ym-w .ym-w-tile[data-state="placed"] { outline: 3px solid var(--w-ring); outline-offset: -3px; }
.ym-w .ym-w-tile[data-state="placed"][data-blank="true"] { outline-color: var(--w-accent); }
.ym-w .ym-w-tile[data-state="last"]::after { content: ""; position: absolute; top: 0; left: 0;
  border: 0.45em solid var(--w-notch); border-right-color: transparent; border-bottom-color: transparent; }
.ym-w .ym-w-tile[data-state="last"][data-blank="true"]::after { border-top-color: var(--w-accent);
  border-left-color: var(--w-accent); }
.ym-w .ym-w-sq:focus-visible { outline: 2px solid var(--w-accent); outline-offset: -2px;
  box-shadow: inset 0 0 0 4px var(--w-ring); }
.ym-w .ym-w-sq:focus-visible .ym-w-tile { box-shadow: inset 0 0 0 4px var(--w-ring); }
.ym-w .ym-w-sq:focus-visible .ym-w-tile[data-blank="true"] { box-shadow: inset 0 0 0 4px var(--w-accent); }
.ym-w .ym-w-tile[data-selected="true"] { outline: 3px solid var(--w-accent); outline-offset: 1px; overflow: visible; }
.ym-w-toolbar { display: flex; gap: 0.25rem; justify-content: flex-end; align-items: center; }
.ym-w-toolbar span { margin-inline-end: auto; }
.ym-w-toolbar button { min-width: 2.75rem; min-height: 2.75rem; border: 1px solid var(--w-ink);
  border-radius: 8px; background: var(--w-paper); font-weight: 700; }
.ym-w-status { min-height: 2.5rem; font-size: 0.95rem; margin: 0; display: flex; flex-direction: column;
  justify-content: center; }
.ym-w-status [data-tone="bad"] { color: var(--w-bad); }
.ym-w-status [data-tone="ok"] { color: var(--w-ok); }
.ym-w-score { font-weight: 800; }
.ym-w-rack { display: flex; gap: 0.25rem; min-height: calc(var(--w-rack) + 0.5rem); padding: 0.25rem;
  border-radius: 8px; background: var(--w-line); touch-action: none; align-items: center;
  flex-wrap: wrap; justify-content: center; }
.ym-w-rack .ym-w-tile { width: var(--w-rack); height: var(--w-rack); font-size: 1.25rem;
  padding: 0; cursor: grab; }
.ym-w-rack .ym-w-tile small { font-size: 0.6em; }
.ym-w-return { min-height: var(--w-rack); padding: 0 0.75rem; border: 1px dashed var(--w-ink);
  border-radius: 8px; background: transparent; }
.ym-w-actions { display: flex; gap: 0.25rem; }
.ym-w-actions button, .ym-w-dialog button { min-height: 2.75rem; min-width: 2.75rem;
  padding: 0 0.9rem; border: 1px solid var(--w-ink); border-radius: 8px; background: var(--w-paper);
  font-weight: 600; }
.ym-w-actions button { flex: 1 1 0; min-width: 0; padding: 0 0.25rem; font-size: 0.9rem; }
.ym-w-actions .ym-w-primary { flex-grow: 1.6; }
.ym-w-actions .ym-w-primary, .ym-w-dialog .ym-w-primary { background: var(--w-ink);
  border-color: var(--w-ink); color: var(--w-paper); }
.ym-w-scrim { position: fixed; inset: 0; z-index: 20; display: flex; align-items: flex-end;
  justify-content: center; background: rgba(20, 14, 8, 0.55); }
.ym-w-dialog { width: 100%; max-width: 34rem; max-height: 90vh; overflow: auto; padding: 1rem
  1rem calc(1rem + env(safe-area-inset-bottom)); border-radius: 12px 12px 0 0;
  background: var(--w-paper); color: var(--w-ink); }
.ym-w-scrim:focus, .ym-w-dialog:focus { outline: none; }
.ym-w-dialog h2 { margin: 0 0 0.5rem; font-size: 1.125rem; }
.ym-w-picker { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.25rem; margin: 0.5rem 0; }
.ym-w-picker button { font-size: 1.125rem; font-weight: 800; }
.ym-w-pick-tiles { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0.5rem 0; }
.ym-w-pick-tiles .ym-w-tile { width: var(--w-rack); height: var(--w-rack); font-size: 1.25rem; }
.ym-w-buttons { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 0.75rem; }
.ym-w-ghost { position: fixed; z-index: 30; width: var(--w-rack); height: var(--w-rack);
  pointer-events: none; transform: translate(-50%, -50%); opacity: 0.9; }
.ym-w-ghost .ym-w-tile { font-size: 1.25rem; }
.ym-w-final { margin: 0; padding: 0.5rem 0.75rem; border: 2px solid var(--w-ink); border-radius: 8px; }
.ym-w-final h2 { margin: 0 0 0.25rem; font-size: 1.125rem; }
.ym-w-final ul { margin: 0; padding-left: 1.25rem; }
.ym-w-racks { display: flex; flex-wrap: wrap; gap: 2px; margin-inline-start: 0.5rem;
  vertical-align: middle; }
.ym-w-mini { display: inline-flex; width: 1.5rem; height: 1.5rem; }
.ym-w-options fieldset { margin: 0 0 1rem; padding: 0; border: 0; }
.ym-w-card { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem; margin: 0.5rem 0;
  border: 2px solid var(--w-line); border-radius: 8px; }
.ym-w-card:has(input:checked) { border-color: var(--w-ink); }
.ym-w-card svg { flex: none; width: 4.5rem; height: 4.5rem; border: 1px solid var(--w-ink); }
.ym-w-detail { color: var(--w-muted); }
@media (max-width: 359px) { .ym-w { --w-rack: 2.5rem; } }
@media (prefers-reduced-motion: no-preference) {
  .ym-w-grid { transition: transform 0.15s ease-out; }
  .ym-w-grid[data-gesture="true"] { transition: none; }
}
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
