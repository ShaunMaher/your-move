/**
 * A modal sheet: labelled, focus moves into it and is kept inside (Tab and Shift-Tab wrap), the
 * page behind it is `inert` while it is open, Escape or a tap on the backdrop closes it, and focus
 * returns to what had it when it opened. `variant="drawer"` slides it up from the bottom edge.
 *
 * It renders into its own container on `document.body`, beside the app's root, so the root can be
 * made inert without making the dialog inert with it.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** The sheet's tabbable elements, in order: not disabled, hidden or inside something that is. */
function tabbable(sheet: HTMLElement | null): HTMLElement[] {
  if (sheet === null) return [];
  return Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.matches(":disabled") &&
      element.closest("[hidden], [inert], fieldset:disabled") === null &&
      element.getAttribute("tabindex") !== "-1",
  );
}

/** Makes everything else on the page inert; returns what puts it back as it was. */
function isolate(container: HTMLElement): () => void {
  const made: Element[] = [];
  for (const other of Array.from(document.body.children)) {
    if (other === container || other.tagName === "SCRIPT" || other.hasAttribute("inert")) continue;
    other.setAttribute("inert", "");
    made.push(other);
  }
  return () => {
    for (const other of made) other.removeAttribute("inert");
  };
}

interface DialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly variant?: "dialog" | "drawer";
  readonly children: ReactNode;
}

export function Dialog(props: DialogProps) {
  const { title, children, variant = "dialog" } = props;
  const titleId = useId();
  const [container] = useState(() => document.createElement("div"));
  const scrim = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  /** Whether the press that ends in a click began on the backdrop itself. */
  const pressedBackdrop = useRef(false);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    document.body.append(container);
    const restore = isolate(container);
    return () => {
      restore();
      container.remove();
    };
  }, [container]);

  useEffect(() => {
    const opener = document.activeElement;
    (tabbable(sheet.current)[0] ?? sheet.current)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Native listeners on the backdrop: keys pressed elsewhere aren't this dialog's business.
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
      const items = tabbable(sheet.current);
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
    // A tap on the backdrop itself closes the dialog; a press that began inside the sheet and
    // ended on the backdrop (selecting text) does not.
    const onPointerDown = (event: Event) => {
      pressedBackdrop.current = event.target === element;
    };
    const onClick = (event: Event) => {
      if (event.target === element && pressedBackdrop.current) latest.current.onClose();
      pressedBackdrop.current = false;
    };
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("click", onClick);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("click", onClick);
    };
  }, []);

  return createPortal(
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
    </div>,
    container,
  );
}
