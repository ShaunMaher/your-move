import { useEffect, useRef } from "react";

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
