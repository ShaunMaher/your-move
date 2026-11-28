// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog.js";

afterEach(cleanup);

function Page(props: { onClose?: () => void; inside?: React.ReactNode; dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      {open ? (
        <Dialog
          title="Sheet"
          dismissible={props.dismissible ?? true}
          onClose={() => {
            props.onClose?.();
            setOpen(false);
          }}
        >
          {props.inside ?? (
            <>
              <button type="button">First</button>
              <button type="button" disabled>
                Off
              </button>
              <textarea aria-label="Note" />
              <button type="button">Last</button>
            </>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}

function open() {
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
}
const tab = (shiftKey = false) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey });
};

describe("Dialog", () => {
  it("focuses the first control and wraps Tab and Shift-Tab inside the sheet", () => {
    render(<Page />);
    open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    // Shift-Tab from the first wraps to the last, which is not the disabled button.
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
    // A textarea counts, and Tab from the last control before it is left to the browser.
    screen.getByLabelText("Note").focus();
    tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Note"));
    screen.getByRole("button", { name: "Last" }).focus();
    tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  });

  it("counts links, summaries and tabindex elements, and skips hidden ones", () => {
    render(
      <Page
        inside={
          <>
            <a href="/x">Link</a>
            <details>
              <summary>More</summary>
            </details>
            <span tabIndex={0} role="button" aria-label="Scrolling">
              scroll
            </span>
            <div tabIndex={-1}>not tabbable</div>
            <button type="button" hidden>
              Hidden
            </button>
          </>
        }
      />,
    );
    open();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Link" }));
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Scrolling" }));
    tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Link" }));
  });

  it("makes the page behind it inert while open and restores it, and focus, on close", () => {
    const root = document.createElement("div");
    document.body.append(root);
    render(<Page />, { container: root });
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    open();
    expect(root.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(root.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
    root.remove();
  });

  it("closes on a tap on the backdrop, not on one inside the sheet or a drag that ends there", () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} />);
    open();
    const sheet = screen.getByRole("dialog");
    const scrim = sheet.parentElement!;
    fireEvent.pointerDown(sheet);
    fireEvent.click(sheet);
    expect(onClose).not.toHaveBeenCalled();
    // Pressed inside the sheet and released on the backdrop (a text selection): not a tap on it.
    fireEvent.pointerDown(sheet);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape and a backdrop tap while it is not dismissible", () => {
    const onClose = vi.fn();
    render(<Page onClose={onClose} dismissible={false} />);
    open();
    const sheet = screen.getByRole("dialog");
    fireEvent.keyDown(sheet, { key: "Escape" });
    fireEvent.pointerDown(sheet.parentElement!);
    fireEvent.click(sheet.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("leaves out what a closed details hides, but keeps its summary", () => {
    render(
      <Page
        inside={
          <>
            <button type="button">Before</button>
            <details>
              <summary>More</summary>
              <a href="/x">Inside</a>
            </details>
          </>
        }
      />,
    );
    open();
    // Closed: the summary is the last stop; the link is not reachable.
    tab(true);
    expect(document.activeElement).toBe(screen.getByText("More"));
    tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Before" }));
    // Open: the link is the last stop.
    document.querySelector("details")!.open = true;
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Inside" }));
  });
});
