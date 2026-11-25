/**
 * A modal sheet: labelled, focus moves into it and is kept inside, Escape closes it, and focus
 * returns to what had it when it opened. `variant="drawer"` slides it up from the bottom edge.
 */
import { type ReactNode, useEffect, useId, useRef } from "react";

const FOCUSABLE = "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled)";

interface DialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly variant?: "dialog" | "drawer";
  readonly children: ReactNode;
}

export function Dialog(props: DialogProps) {
  const { title, children, variant = "dialog" } = props;
  const titleId = useId();
  const scrim = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const opener = document.activeElement;
    const items = sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (items?.[0] ?? sheet.current)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // A native listener on the backdrop: keys pressed elsewhere aren't this dialog's business.
  useEffect(() => {
    const element = scrim.current;
    if (element === null) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(sheet.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      const first = items[0];
      const last = items.at(-1);
      const active = document.activeElement;
      if (first === undefined || last === undefined) event.preventDefault();
      else if (event.shiftKey && (active === first || active === sheet.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener("keydown", onKeyDown);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div ref={scrim} className="scrim" data-variant={variant}>
      <div
        ref={sheet}
        className="sheet stack"
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
