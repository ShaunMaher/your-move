import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/**
 * Calls `refresh` when the page regains focus or becomes visible and, if `pollMs` is set, every
 * `pollMs` while it is visible: the alpha's stand-in for realtime (10, Alpha). A pending call is
 * the caller's to deduplicate.
 */
export function useRefresh(refresh: () => void, pollMs: number | null): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    const call = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    document.addEventListener("visibilitychange", call);
    window.addEventListener("focus", call);
    const timer = pollMs === null ? undefined : setInterval(call, pollMs);
    return () => {
      document.removeEventListener("visibilitychange", call);
      window.removeEventListener("focus", call);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [pollMs]);
}

/**
 * Keeps a game or a list out of the browser's back-forward cache, and refetches it when the page
 * comes back (07 §4). `pagehide` with `persisted` (the page may be frozen) calls `freeze`, which
 * drops what is on screen; `pageshow` with `persisted` (a restored page runs no new load) calls
 * `restored`, which fetches again, so a view the server has since replaced never comes back on
 * screen (02 §3; games/pairs.md §9). Both run inside `flushSync`: these are not discrete events
 * for React, which would otherwise commit the change in a later task, after the browser had
 * painted the old view. An ordinary `pageshow` (a first load) is not a restore.
 */
export function useRestored(restored: () => void, freeze: () => void): void {
  const latest = useRef({ restored, freeze });
  useEffect(() => {
    latest.current = { restored, freeze };
  });
  useEffect(() => {
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) {
        flushSync(() => {
          latest.current.restored();
        });
      }
    };
    const hide = (event: PageTransitionEvent) => {
      if (event.persisted) {
        flushSync(() => {
          latest.current.freeze();
        });
      }
    };
    window.addEventListener("pageshow", show);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pageshow", show);
      window.removeEventListener("pagehide", hide);
    };
  }, []);
}

/** Whether the tab is showing: a hidden one polls nothing and has seen nothing. */
export function useVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  useEffect(() => {
    const update = () => {
      setVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return visible;
}
