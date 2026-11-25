/**
 * A minimal History-API router: the app has a handful of flat routes (07 §1), so a dependency
 * would cost more than these forty lines.
 */
import { type MouseEvent, type ReactNode, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** Moves to a same-origin path. `replace` keeps the Back button from returning to the old one. */
export function navigate(path: string, options: { readonly replace?: boolean } = {}): void {
  if (options.replace === true) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

/** The current path (without query or fragment). */
export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

interface LinkProps {
  readonly to: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/** A real link (open in a new tab works) that navigates without a page load on a plain click. */
export function Link({ to, className, children }: LinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
