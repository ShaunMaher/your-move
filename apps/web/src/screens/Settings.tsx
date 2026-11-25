/**
 * The part of `/settings` (07 §1) the sign-in slice needs: who is signed in, sign out, and sign
 * out everywhere with the choice to revoke API tokens too (06 §4). The rest of the screen arrives
 * with its features.
 */
import type { ApiClient } from "@your-move/api-client";
import { useState } from "react";

import { type Me, signOutEverywhere } from "../auth-api.js";
import { Link } from "../router.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface SettingsProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly me: Me;
  readonly onSignOut: () => void;
  readonly onSignedOut: () => void;
}

export function Settings({ api, appName, me, onSignOut, onSignedOut }: SettingsProps) {
  const [confirming, setConfirming] = useState(false);
  const [revokeTokens, setRevokeTokens] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <h1>Settings</h1>
      <section className="card stack" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <dl className="details">
          <dt>Display name</dt>
          <dd>{me.displayName}</dd>
          <dt>Email</dt>
          <dd>{me.email}</dd>
        </dl>
      </section>
      <section className="card stack" aria-labelledby="signout-heading">
        <h2 id="signout-heading">Sign out</h2>
        <button type="button" className="button secondary" onClick={onSignOut}>
          Sign out
        </button>
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
