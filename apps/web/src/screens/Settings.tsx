/**
 * The parts of `/settings` (07 §1) built so far: who is signed in, notifications on this device
 * (07 §4, alpha A8), the email nudges toggle (03 §7, alpha A6), sign out, and sign out everywhere
 * with the choice to revoke API tokens too (06 §4). The rest of the screen arrives with its
 * features.
 */
import type { ApiClient } from "@your-move/api-client";
import { useEffect, useState } from "react";

import { type Me, saveEmailNudges, signOutEverywhere } from "../auth-api.js";
import { type PushChange, pushState, type PushState, turnOffPush, turnOnPush } from "../push.js";
import { Link } from "../router.js";
import { useSignOut } from "../use-sign-out.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface SettingsProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly me: Me;
  /** The instance's VAPID public key; without one it sends no pushes. */
  readonly pushKey: string | undefined;
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

const PUSH_PROBLEMS: Partial<Record<PushChange, string>> = {
  offline: "You seem to be offline. Notifications weren't changed. Try again.",
  failed: "Notifications couldn't be changed on this device. Please try again.",
};

/**
 * Notifications on this device (07 §4): a toggle where push can work, and otherwise what stands in
 * the way, with the way to the Home Screen on iOS Safari. Turning it on asks for permission from
 * the tap itself.
 */
function PushNotifications({
  api,
  appName,
  pushKey,
  onSessionLost,
}: Pick<SettingsProps, "api" | "appName" | "pushKey" | "onSessionLost">) {
  const [state, setState] = useState<PushState | "checking">("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void pushState(pushKey).then((found) => {
      if (live) setState(found);
    });
    return () => {
      live = false;
    };
  }, [pushKey]);

  function settle(change: PushChange) {
    setPending(false);
    if (change === "unauthenticated") {
      onSessionLost();
      return;
    }
    if (change === "on" || change === "off" || change === "denied") setState(change);
    setError(PUSH_PROBLEMS[change] ?? null);
  }

  function toggle(on: boolean) {
    if (pending || pushKey === undefined) return;
    setPending(true);
    setError(null);
    // Straight from the tap: the permission prompt needs it (iOS).
    void (on ? turnOnPush(api, pushKey) : turnOffPush(api)).then(settle);
  }

  let body;
  if (state === "checking") body = <p role="status">Checking this device…</p>;
  else if (state === "no-server-key") body = <p>{appName} doesn&apos;t send notifications.</p>;
  else if (state === "needs-install") {
    body = (
      <p>
        On iPhone and iPad, notifications work once {appName} is on your Home Screen. Open it from
        there and turn them on here. <Link to="/install">How to add it to your Home Screen</Link>
      </p>
    );
  } else if (state === "unsupported") {
    body = <p>This browser can&apos;t show notifications from {appName}.</p>;
  } else if (state === "denied") {
    body = (
      <p>
        Notifications from {appName} are blocked on this device. To get them, allow them in your
        browser or device settings, then come back here.
      </p>
    );
  } else {
    body = (
      <>
        <label className="check">
          <input
            type="checkbox"
            checked={state === "on"}
            disabled={pending}
            aria-describedby="push-help push-problem"
            onChange={(event) => {
              toggle(event.target.checked);
            }}
          />
          Notify me on this device
        </label>
        <p id="push-help">
          When it&apos;s your turn, or a game ends. A notification names the players and says what
          was played, nothing else about the game.
        </p>
      </>
    );
  }

  return (
    <section className="card stack" aria-labelledby="push-heading">
      <h2 id="push-heading">Notifications</h2>
      {body}
      <Problem id="push-problem" message={error} />
    </section>
  );
}

export function Settings({
  api,
  appName,
  me,
  pushKey,
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
      <PushNotifications
        api={api}
        appName={appName}
        pushKey={pushKey}
        onSessionLost={onSessionLost}
      />
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
