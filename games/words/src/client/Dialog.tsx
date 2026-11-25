/**
 * A modal sheet: labelled, focus moves into it and is kept inside, Escape closes it, and focus
 * returns to what had it when it opens (docs/spec/07-frontend.md §2).
 */
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled)";

export function Dialog(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactElement {
  const { title, onClose, children } = props;
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement;
    const focusable = (): HTMLElement[] =>
      Array.from(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (focusable()[0] ?? sheet.current)?.focus();
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items.at(-1);
        const active = document.activeElement;
        if (first === undefined || last === undefined) {
          event.preventDefault();
        } else if (event.shiftKey && (active === first || !sheet.current?.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !sheet.current?.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  return (
    <div className="ym-w-scrim">
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
