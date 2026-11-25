/**
 * The parts of `/settings` (07 §1) built so far: who is signed in, the email nudges toggle (03 §7,
 * alpha A6), sign out, and sign out everywhere with the choice to revoke API tokens too (06 §4).
 * The rest of the screen arrives with its features.
 */
import type { ApiClient } from "@your-move/api-client";
import { useState } from "react";

import { type Me, saveEmailNudges, signOutEverywhere } from "../auth-api.js";
import { Link } from "../router.js";
import { useSignOut } from "../use-sign-out.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface SettingsProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly me: Me;
  /** The server's answer after a setting changed. */
  readonly onMeChanged: (me: Me) => void;
  /** A call answered 401: the session ended elsewhere. */
  readonly onSessionLost: () => void;
  readonly onSignedOut: () => void;
}

/** The email nudges toggle (03 §7): saved at once, shown as the server's answer. */
function EmailNudges({
  api,
  me,
  onMeChanged,
  onSessionLost,
}: Pick<SettingsProps, "api" | "me" | "onMeChanged" | "onSessionLost">) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(emailNudges: boolean) {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await saveEmailNudges(api, emailNudges);
    setPending(false);
    if (outcome.ok) {
      onMeChanged(outcome.data);
      return;
    }
    if (outcome.failure === "unauthenticated") {
      onSessionLost();
      return;
    }
    setError(
      outcome.failure === "offline"
        ? "You seem to be offline. Your setting wasn't saved. Try again."
        : "Your setting wasn't saved. Please try again.",
    );
  }

  return (
    <section className="card stack" aria-labelledby="email-heading">
      <h2 id="email-heading">Emails</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={me.settings.emailNudges}
          disabled={pending}
          aria-describedby="email-nudges-help email-nudges-problem"
          onChange={(event) => void change(event.target.checked)}
        />
        Email me when it&apos;s my turn
      </label>
      <p id="email-nudges-help">
        When a game has waited a day for your move, we&apos;ll email you, at most once a day for
        each game. Every email has a link to turn this off.
      </p>
      <Problem id="email-nudges-problem" message={error} />
    </section>
  );
}

export function Settings({
  api,
  appName,
  me,
  onMeChanged,
  onSessionLost,
  onSignedOut,
}: SettingsProps) {
  const [confirming, setConfirming] = useState(false);
  const [revokeTokens, setRevokeTokens] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaving = useSignOut(api, onSignedOut);

  async function everywhere() {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await signOutEverywhere(api, revokeTokens);
    // A 401 means the session was already gone, which is the outcome asked for.
    if (outcome.ok || outcome.failure === "unauthenticated") {
      onSignedOut();
      return;
    }
    setPending(false);
    setError(
      outcome.failure === "offline"
        ? "You seem to be offline. Check your connection and try again."
        : "Something went wrong. Please try again.",
    );
  }

  return (
    <Page appName={appName} nav={<Link to="/">Home</Link>}>
      <h1 tabIndex={-1}>Settings</h1>
      <section className="card stack" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <dl className="details">
          <dt>Display name</dt>
          <dd>{me.displayName}</dd>
          <dt>Email</dt>
          <dd>{me.email}</dd>
        </dl>
      </section>
      <section className="card stack" aria-labelledby="install-heading">
        <h2 id="install-heading">Home Screen</h2>
        <p>
          <Link to="/install">How to add {appName} to your Home Screen</Link>
        </p>
      </section>
      <EmailNudges api={api} me={me} onMeChanged={onMeChanged} onSessionLost={onSessionLost} />
      <section className="card stack" aria-labelledby="signout-heading">
        <h2 id="signout-heading">Sign out</h2>
        <button
          type="button"
          className="button secondary"
          disabled={leaving.pending}
          onClick={leaving.signOut}
        >
          {leaving.pending ? "Signing out…" : "Sign out"}
        </button>
        <Problem id="signout-problem" message={leaving.error} />
        {confirming ? (
          <div className="stack" role="group" aria-labelledby="everywhere-heading">
            <h3 id="everywhere-heading">Sign out everywhere?</h3>
            <p>
              This signs you out on every device where you&apos;re signed in, including this one.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={revokeTokens}
                onChange={(event) => {
                  setRevokeTokens(event.target.checked);
                }}
              />
              Also revoke all my API tokens
            </label>
            <Problem id="everywhere-problem" message={error} />
            <div className="row">
              <button
                type="button"
                className="button danger"
                disabled={pending}
                onClick={() => void everywhere()}
              >
                {pending ? "Signing out…" : "Sign out everywhere"}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Sign out everywhere…
          </button>
        )}
      </section>
    </Page>
  );
}
