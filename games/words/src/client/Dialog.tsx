/**
 * A modal sheet: labelled, focus moves into it and is kept inside, Escape closes it, and focus
 * returns to what had it when it opens (docs/spec/07-frontend.md §2), or to `restoreTo` when that
 * element is gone (a tile that was dropped, then taken back). The keys are handled on the sheet's
 * own backdrop, so a key pressed anywhere else on the page isn't this dialog's business.
 */
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled)";

export function Dialog(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly restoreTo: () => HTMLElement | null;
  readonly children: ReactNode;
}): ReactElement {
  const { title, children } = props;
  const titleId = useId();
  const scrim = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const latest = useRef(props);

  useEffect(() => {
    latest.current = props;
  });

  const focusable = (): HTMLElement[] =>
    Array.from(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);

  useEffect(() => {
    const opener = document.activeElement;
    (focusable()[0] ?? sheet.current)?.focus();
    return () => {
      const back =
        opener instanceof HTMLElement && opener !== document.body && opener.isConnected
          ? opener
          : latest.current.restoreTo();
      back?.focus();
    };
  }, []);

  // A native listener on the dialog's own backdrop: keys pressed elsewhere aren't its business.
  useEffect(() => {
    const element = scrim.current;
    if (element === null) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onClose();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        const active = document.activeElement;
        if (first === undefined || last === undefined) {
          event.preventDefault();
        } else if (
          event.shiftKey &&
          (active === first || active === scrim.current || active === sheet.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || active === scrim.current)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div ref={scrim} className="ym-w-scrim" tabIndex={-1}>
      <div
        ref={sheet}
        className="ym-w-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
