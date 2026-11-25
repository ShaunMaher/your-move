import { Link } from "../router.js";
import { Page } from "./Page.js";

/** The first load, before the instance's name is known (so there is none to show yet). */
export function Loading() {
  return (
    <div className="shell">
      <main className="stack">
        <h1 className="visually-hidden">Loading</h1>
        <p role="status">Loading…</p>
      </main>
    </div>
  );
}

interface UnreachableProps {
  readonly offline: boolean;
  readonly onRetry: () => void;
}

/** The shell loaded (from the service worker if need be) but the API did not answer (07 §4). */
export function Unreachable({ offline, onRetry }: UnreachableProps) {
  return (
    <div className="shell">
      <main className="stack">
        <h1>{offline ? "You're offline" : "Can't reach the server"}</h1>
        <p role="status">
          {offline
            ? "Check your connection. We'll try again when you're back online."
            : "The server isn't answering right now. Try again in a moment."}
        </p>
        <button type="button" className="button" onClick={onRetry}>
          Try again
        </button>
      </main>
    </div>
  );
}

export function NotFound({ appName }: { readonly appName: string }) {
  return (
    <Page appName={appName}>
      <h1>Page not found</h1>
      <p>
        There&apos;s nothing at this address. <Link to="/">Go to the home screen</Link>.
      </p>
    </Page>
  );
}
