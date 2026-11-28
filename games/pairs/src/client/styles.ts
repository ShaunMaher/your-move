/**
 * The board's stylesheet, as text (docs/spec/games/pairs.md §9). A client module is plain
 * JavaScript (02 §3, §7.1.1) and the page's CSP allows no inline styles (08 §3), so the sheet is
 * installed as a constructable stylesheet, which that policy doesn't restrict. A browser without
 * them (07 §1) is told to update; there is no `<style>` fallback.
 *
 * The look is original (07 §5): cool paper and ink, cream cards with drawings in four plain
 * colours, a blue lattice for the card back. It follows the theme like the shell does: light by
 * default, dark under `prefers-color-scheme: dark` unless the person chose light, and dark when
 * they chose dark. Colour is never the only signal: a card's face is told apart by its shape, the
 * missed pair has a dashed outline and a player number, the first card a solid one, a matched card
 * a check and its finder's number. `styles.test.ts` checks the contrast of each pair in `PAIRS` in
 * both themes.
 */

/** Every themed colour of the board. */
export interface Tokens {
  readonly paper: string;
  readonly ink: string;
  readonly muted: string;
  readonly line: string;
  readonly accent: string;
  readonly bad: string;
  readonly ok: string;
  readonly "turn-bg": string;
  readonly "turn-ink": string;
  /** A face-up card, and the four colours its drawing uses. */
  readonly face: string;
  readonly k1: string;
  readonly k2: string;
  readonly k3: string;
  readonly k4: string;
  /** A matched (dimmed) card, its drawing's colours and its ink. */
  readonly done: string;
  readonly "done-ink": string;
  readonly d1: string;
  readonly d2: string;
  readonly d3: string;
  readonly d4: string;
  /** The card back, and its pattern. */
  readonly back: string;
  readonly "back-line": string;
}

type Token = keyof Tokens;

export const LIGHT: Tokens = {
  paper: "#f6f8fa",
  ink: "#1b2230",
  muted: "#465163",
  line: "#aab5c3",
  accent: "#92400e",
  bad: "#a31d1d",
  ok: "#1c6b3a",
  "turn-bg": "#92400e",
  "turn-ink": "#ffffff",
  face: "#fffaf0",
  k1: "#b3261e",
  k2: "#1f5fa8",
  k3: "#2e7d32",
  k4: "#9a6400",
  done: "#dfe5ec",
  "done-ink": "#4a5565",
  d1: "#9b4a45",
  d2: "#4a6e99",
  d3: "#4f7a52",
  d4: "#86652a",
  back: "#3a5a8c",
  "back-line": "#d7e3f4",
};

export const DARK: Tokens = {
  paper: "#12161c",
  ink: "#e8edf3",
  muted: "#aab5c3",
  line: "#3b4656",
  accent: "#f4b942",
  bad: "#ff9b95",
  ok: "#7fd49b",
  "turn-bg": "#f4b942",
  "turn-ink": "#1b1405",
  face: "#2a3342",
  k1: "#ff8a80",
  k2: "#7db7ff",
  k3: "#7fd49b",
  k4: "#f4b942",
  done: "#1d242e",
  "done-ink": "#aab5c3",
  d1: "#c47a74",
  d2: "#6f9ed1",
  d3: "#6fae85",
  d4: "#c9a04a",
  back: "#5578b0",
  "back-line": "#dbe6f5",
};

/** A text or non-text colour pair that must stay readable (WCAG 2.2 §1.4.3, §1.4.11). */
export interface Pair {
  readonly what: string;
  readonly fg: Token;
  readonly bg: Token;
  /** Text needs 4.5:1; borders, drawings and other parts of the interface 3:1. */
  readonly kind: "text" | "non-text";
}

export const PAIRS: readonly Pair[] = [
  { what: "text on the page", fg: "ink", bg: "paper", kind: "text" },
  { what: "secondary text on the page", fg: "muted", bg: "paper", kind: "text" },
  { what: "error text", fg: "bad", bg: "paper", kind: "text" },
  { what: "confirmation text", fg: "ok", bg: "paper", kind: "text" },
  { what: "the acting player's chip", fg: "paper", bg: "ink", kind: "text" },
  { what: "a player number's badge", fg: "paper", bg: "ink", kind: "text" },
  { what: "a matched card's badge", fg: "paper", bg: "done-ink", kind: "text" },
  { what: "your-turn line", fg: "turn-ink", bg: "turn-bg", kind: "text" },
  { what: "your-turn line against the page", fg: "turn-bg", bg: "paper", kind: "non-text" },
  { what: "card borders against the page", fg: "muted", bg: "paper", kind: "non-text" },
  { what: "focus ring on the page", fg: "accent", bg: "paper", kind: "non-text" },
  {
    what: "first-card and missed-pair outlines on the page",
    fg: "accent",
    bg: "paper",
    kind: "non-text",
  },
  { what: "outlines on a face-up card", fg: "accent", bg: "face", kind: "non-text" },
  { what: "a drawing's lines on its card", fg: "ink", bg: "face", kind: "non-text" },
  { what: "a drawing's red on its card", fg: "k1", bg: "face", kind: "non-text" },
  { what: "a drawing's blue on its card", fg: "k2", bg: "face", kind: "non-text" },
  { what: "a drawing's green on its card", fg: "k3", bg: "face", kind: "non-text" },
  { what: "a drawing's gold on its card", fg: "k4", bg: "face", kind: "non-text" },
  { what: "a dimmed card's drawing lines", fg: "done-ink", bg: "done", kind: "non-text" },
  { what: "a dimmed card's red", fg: "d1", bg: "done", kind: "non-text" },
  { what: "a dimmed card's blue", fg: "d2", bg: "done", kind: "non-text" },
  { what: "a dimmed card's green", fg: "d3", bg: "done", kind: "non-text" },
  { what: "a dimmed card's gold", fg: "d4", bg: "done", kind: "non-text" },
  { what: "a dimmed card's check mark", fg: "done-ink", bg: "done", kind: "non-text" },
  { what: "the card back against the page", fg: "back", bg: "paper", kind: "non-text" },
  { what: "the card back's pattern", fg: "back-line", bg: "back", kind: "non-text" },
];

const vars = (tokens: Tokens): string =>
  (Object.keys(tokens) as Token[]).map((name) => `--pr-${name}: ${tokens[name]};`).join(" ");

/** The flip's duration in milliseconds (pairs §9: about 250 ms); the sheet's animations use it too. */
export const FLIP_MS = 250;

const CSS = `
.ym-pr { ${vars(LIGHT)} color-scheme: light;
  color: var(--pr-ink); background: transparent; display: flex; flex-direction: column;
  gap: 0.5rem; max-width: 34rem; margin: 0 auto; padding: 0.25rem 0 calc(0.5rem + env(safe-area-inset-bottom));
  font-family: system-ui, -apple-system, sans-serif; font-size: 1rem; box-sizing: border-box; }
:root[data-theme="dark"] .ym-pr { ${vars(DARK)} color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .ym-pr { ${vars(DARK)} color-scheme: dark; }
}
.ym-pr *, .ym-pr *::before, .ym-pr *::after { box-sizing: border-box; }
.ym-pr :where(button) { font: inherit; color: inherit; cursor: pointer; }
.ym-pr :where(input) { color: var(--pr-ink); background: var(--pr-paper); }
.ym-pr :focus-visible { outline: 3px solid var(--pr-accent); outline-offset: 2px; }
.ym-pr-vh { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }
.ym-pr-players { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.15rem 0.5rem;
  margin: 0; padding: 0; list-style: none; }
.ym-pr-players li { display: flex; align-items: center; gap: 0.35rem; min-width: 0; min-height: 1.5rem;
  padding: 0 0.4rem 0 0.15rem; border: 2px solid transparent; border-radius: 999px; white-space: nowrap; }
.ym-pr-players [aria-current="true"] { background: var(--pr-ink); color: var(--pr-paper);
  border-color: var(--pr-ink); font-weight: 700; }
.ym-pr-players [data-out="true"] { font-style: italic; color: var(--pr-muted); }
.ym-pr-who { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ym-pr-score { flex: none; }
.ym-pr-no { flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.2rem; height: 1.2rem; padding: 0 0.2rem; border-radius: 999px; background: var(--pr-ink);
  color: var(--pr-paper); font-size: 0.75rem; font-weight: 800; line-height: 1; }
.ym-pr-players [aria-current="true"] .ym-pr-no { background: var(--pr-paper); color: var(--pr-ink); }
@media (min-width: 480px) { .ym-pr-players { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; } }
.ym-pr-turn { margin: 0; padding: 0.3rem 0.75rem; border: 2px solid var(--pr-line);
  border-radius: 8px; font-weight: 600; color: var(--pr-muted); }
.ym-pr-turn[data-yours="true"] { background: var(--pr-turn-bg); color: var(--pr-turn-ink);
  border-color: var(--pr-turn-bg); font-weight: 800; }
.ym-pr-board { display: flex; flex-direction: column; gap: 4px; width: 100%; }
.ym-pr-board[data-cols="4"] { --pr-cols: 4; }
.ym-pr-board[data-cols="5"] { --pr-cols: 5; }
.ym-pr-board[data-cols="6"] { --pr-cols: 6; }
.ym-pr-row { display: grid; grid-template-columns: repeat(var(--pr-cols), minmax(0, 88px));
  gap: 4px; justify-content: center; }
.ym-pr-cell { position: relative; min-width: 0; aspect-ratio: 1; }
.ym-pr .ym-pr-card { position: relative; display: block; width: 100%; height: 100%; padding: 0;
  border: 2px solid var(--pr-muted); border-radius: 8px; overflow: hidden; background: var(--pr-face);
  color: var(--pr-ink); }
.ym-pr .ym-pr-card[aria-disabled="true"] { cursor: default; }
.ym-pr .ym-pr-card[data-state="down"] { border-color: var(--pr-back); background: var(--pr-back); }
.ym-pr .ym-pr-card[data-state="matched"] { background: var(--pr-done); color: var(--pr-done-ink); }
.ym-pr .ym-pr-card[data-state="unfound"] { border-style: dashed; }
.ym-pr .ym-pr-card[data-state="up"] { outline: 3px solid var(--pr-accent); outline-offset: 1px; }
.ym-pr .ym-pr-card[data-state="missed"] { outline: 3px dashed var(--pr-accent); outline-offset: 1px; }
.ym-pr .ym-pr-card[data-turning="true"] { transform: scale(0.94); cursor: progress; }
.ym-pr .ym-pr-card:focus-visible { outline: 4px double var(--pr-accent); outline-offset: 2px; }
.ym-pr-face, .ym-pr-ghost { position: absolute; inset: 0; display: block; }
.ym-pr-ghost { background: var(--pr-face); }
.ym-pr-art { position: absolute; inset: 3px; width: calc(100% - 6px); height: calc(100% - 6px);
  display: block; pointer-events: none; }
.ym-pr-back { inset: 0; width: 100%; height: 100%; }
.ym-pr-back-bg { fill: var(--pr-back); }
.ym-pr-back-line { fill: none; stroke: var(--pr-back-line); stroke-width: 2; }
.ym-pr-back-dot { fill: var(--pr-back-line); }
.ym-pr-art .ym-pr-line { stroke: var(--pr-ink); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.ym-pr-art .ym-pr-ink { fill: var(--pr-ink); }
.ym-pr-art .ym-pr-k1 { fill: var(--pr-k1); }
.ym-pr-art .ym-pr-k2 { fill: var(--pr-k2); }
.ym-pr-art .ym-pr-k3 { fill: var(--pr-k3); }
.ym-pr-art .ym-pr-k4 { fill: var(--pr-k4); }
.ym-pr-art .ym-pr-s1, .ym-pr-art .ym-pr-s4 { stroke-width: 5; stroke-linecap: round;
  stroke-linejoin: round; }
.ym-pr-art .ym-pr-s1 { stroke: var(--pr-k1); }
.ym-pr-art .ym-pr-s4 { stroke: var(--pr-k4); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-line { stroke: var(--pr-done-ink); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-ink { fill: var(--pr-done-ink); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-k1 { fill: var(--pr-d1); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-k2 { fill: var(--pr-d2); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-k3 { fill: var(--pr-d3); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-k4 { fill: var(--pr-d4); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-s1 { stroke: var(--pr-d1); }
.ym-pr-card[data-state="matched"] .ym-pr-art .ym-pr-s4 { stroke: var(--pr-d4); }
.ym-pr-badge { position: absolute; top: 1px; right: 1px; display: inline-flex; align-items: center;
  justify-content: center; min-width: 1.15rem; height: 1.15rem; padding: 0 0.2rem; border-radius: 999px;
  background: var(--pr-ink); color: var(--pr-paper); font-size: 0.72rem; font-weight: 800; line-height: 1;
  pointer-events: none; }
.ym-pr-badge::after { content: attr(data-no); }
.ym-pr-card[data-state="matched"] .ym-pr-badge { background: var(--pr-done-ink); }
.ym-pr-flip-in { animation: ym-pr-in ${String(FLIP_MS)}ms ease-out; }
.ym-pr-flip-out { animation: ym-pr-out ${String(FLIP_MS)}ms ease-in forwards; }
@keyframes ym-pr-in { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes ym-pr-out { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
  .ym-pr-flip-in, .ym-pr-flip-out { animation: none; }
  .ym-pr .ym-pr-card[data-turning="true"] { transform: none; }
}
.ym-pr-status { min-height: 2.9rem; margin: 0; display: flex; flex-direction: column;
  justify-content: flex-start; gap: 0.1rem; font-size: 0.95rem; }
.ym-pr-status [data-tone="bad"] { color: var(--pr-bad); font-weight: 700; }
.ym-pr-final { margin: 0; padding: 0.5rem 0.75rem; border: 2px solid var(--pr-ink); border-radius: 8px; }
.ym-pr-final h2 { margin: 0 0 0.25rem; font-size: 1.125rem; }
.ym-pr-final p { margin: 0 0 0.25rem; }
.ym-pr-final ul { margin: 0; padding: 0; list-style: none; }
.ym-pr-options fieldset { margin: 0 0 1rem; padding: 0; border: 0; }
.ym-pr-options legend { font-weight: 700; margin-bottom: 0.25rem; }
.ym-pr-choice { display: flex; gap: 0.5rem; align-items: center; min-height: 2.75rem; padding: 0.4rem 0.5rem;
  margin: 0.35rem 0; border: 2px solid var(--pr-line); border-radius: 8px; }
.ym-pr-choice:has(input:checked) { border-color: var(--pr-ink); }
.ym-pr-choice input { flex: none; width: 1.25rem; height: 1.25rem; margin: 0; }
.ym-pr-rules h3 { margin: 0.75rem 0 0.25rem; font-size: 1.05rem; }
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
