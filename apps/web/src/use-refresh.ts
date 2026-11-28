import { useEffect, useRef, useState } from "react";

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
 * Calls `restored` when the page comes back from the browser's back-forward cache (`pageshow` with
 * `persisted`: a restored page runs no new load and shows whatever it showed when it was frozen,
 * 07 §4). The caller then refetches before showing anything again, so a view the server has since
 * replaced never comes back on screen (02 §3; games/pairs.md §9). An ordinary `pageshow` (a first
 * load) is not a restore.
 */
export function useRestored(restored: () => void): void {
  const latest = useRef(restored);
  useEffect(() => {
    latest.current = restored;
  });
  useEffect(() => {
    const call = (event: PageTransitionEvent) => {
      if (event.persisted) latest.current();
    };
    window.addEventListener("pageshow", call);
    return () => {
      window.removeEventListener("pageshow", call);
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
