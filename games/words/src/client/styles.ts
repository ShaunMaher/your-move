/**
 * The board's stylesheet, as text. A client module is plain JavaScript (02 §7.1.1) and the page's
 * CSP allows no inline styles (08 §3), so the sheet is installed as a constructable stylesheet,
 * which that policy doesn't restrict; a browser without them gets a `<style>` element instead.
 * Colours are never the only signal: premium squares carry a label, tiles a letter and points.
 */

const CSS = `
.ym-w { --w-ink: #2b2118; --w-paper: #fbf7ee; --w-line: #cdbf9c; --w-tile: #f6e7bf;
  --w-tile-edge: #b99a52; --w-accent: #1b5e9b; --w-gold: #d99a00; --w-bad: #a3281c;
  --w-ok: #1d6b3a; --w-muted: #5b5043; --w-tw: #a8351f; --w-dw: #e7a79c; --w-tl: #1f6f7d;
  --w-dl: #b3dbe3; --w-cell: #efe6d0; --w-rack: 2.75rem;
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
.ym-w-sq { position: relative; display: flex; align-items: center; justify-content: center;
  min-width: 0; min-height: 0; padding: 0; border: 0; border-radius: 2px; background: var(--w-cell);
  color: var(--w-ink); font-size: 0.5rem; font-size: 2.1cqw; font-weight: 700; line-height: 1;
  overflow: hidden; }
.ym-w-sq[data-premium="TW"] { background: var(--w-tw); color: #fff; }
.ym-w-sq[data-premium="DW"] { background: var(--w-dw); }
.ym-w-sq[data-premium="TL"] { background: var(--w-tl); color: #fff; }
.ym-w-sq[data-premium="DL"] { background: var(--w-dl); }
.ym-w-sq[data-target="true"] { outline: 2px dashed var(--w-accent); outline-offset: -2px; }
.ym-w-tile { display: flex; align-items: center; justify-content: center; position: relative;
  width: 100%; height: 100%; border-radius: 3px; background: var(--w-tile);
  border: 1px solid var(--w-tile-edge); color: var(--w-ink); font-weight: 800; font-size: 0.8rem;
  font-size: 3.8cqw;
  box-shadow: 0 1px 0 var(--w-tile-edge); }
.ym-w-tile small { position: absolute; right: 1px; bottom: 0; font-size: 0.5em; font-weight: 600; }
.ym-w-tile[data-blank="true"] { font-style: italic; color: var(--w-accent); }
.ym-w-tile[data-state="placed"] { border: 2px solid var(--w-accent); }
.ym-w-tile[data-state="last"] { box-shadow: 0 0 0 2px var(--w-gold); }
.ym-w-tile[data-selected="true"] { outline: 3px solid var(--w-accent); outline-offset: 1px; }
.ym-w-zoom { position: absolute; right: 4px; bottom: 4px; display: flex; gap: 4px; z-index: 2; }
.ym-w-zoom button:disabled { opacity: 1; color: var(--w-muted); background: var(--w-line); }
.ym-w-zoom button { min-width: 2.75rem; min-height: 2.75rem; border: 1px solid var(--w-ink);
  border-radius: 6px; background: var(--w-paper); font-weight: 700; }
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
.ym-w-actions .ym-w-primary, .ym-w-dialog .ym-w-primary { background: var(--w-accent);
  border-color: var(--w-accent); color: #fff; }
.ym-w-scrim { position: fixed; inset: 0; z-index: 20; display: flex; align-items: flex-end;
  justify-content: center; background: rgba(20, 14, 8, 0.55); }
.ym-w-dialog { width: 100%; max-width: 34rem; max-height: 90vh; overflow: auto; padding: 1rem
  1rem calc(1rem + env(safe-area-inset-bottom)); border-radius: 12px 12px 0 0;
  background: var(--w-paper); color: var(--w-ink); }
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
.ym-w-card:has(input:checked) { border-color: var(--w-accent); }
.ym-w-card svg { flex: none; width: 4.5rem; height: 4.5rem; border: 1px solid var(--w-ink); }
.ym-w-detail { color: var(--w-muted); }
@media (max-width: 359px) { .ym-w { --w-rack: 2.5rem; } }
@media (prefers-reduced-motion: no-preference) {
  .ym-w-grid { transition: transform 0.15s ease-out; }
  .ym-w-grid[data-gesture="true"] { transition: none; }
}
`;

let installed = false;

/** Installs the stylesheet once per page. */
export function installStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
  }
}
