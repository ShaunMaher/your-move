/**
 * The parts of `/settings` (07 §1) built so far: who is signed in, notifications on this device
 * (07 §4, alpha A8), the email nudges toggle (03 §7, alpha A6), the theme choice (07 §5, alpha A9), sign out, and sign out everywhere
 * with the choice to revoke API tokens too (06 §4). The rest of the screen arrives with its
 * features.
 */
import type { ApiClient } from "@your-move/api-client";
import { useEffect, useRef, useState } from "react";

import {
  type Me,
  type Outcome,
  saveEmailNudges,
  saveTheme,
  signOutEverywhere,
} from "../auth-api.js";
import { type PushChange, pushState, type PushState, turnOffPush, turnOnPush } from "../push.js";
import { Link } from "../router.js";
import { applyTheme, type Theme } from "../theme.js";
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

/**
 * Saving one setting at once: the screen shows the server's answer, so a failed save leaves the
 * control as it was, with the reason beside it.
 */
function useSettingSave<T>(
  save: (value: T) => Promise<Outcome<Me>>,
  { onMeChanged, onSessionLost }: Pick<SettingsProps, "onMeChanged" | "onSessionLost">,
) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Saves `value`; answers whether it was saved. A change during a save is ignored. */
  async function change(value: T): Promise<boolean> {
    if (pending) return false;
    setPending(true);
    setError(null);
    const outcome = await save(value);
    setPending(false);
    if (outcome.ok) {
      onMeChanged(outcome.data);
      return true;
    }
    if (outcome.failure === "unauthenticated") {
      onSessionLost();
      return false;
    }
    setError(
      outcome.failure === "offline"
        ? "You seem to be offline. Your setting wasn't saved. Try again."
        : "Your setting wasn't saved. Please try again.",
    );
    return false;
  }
  return { pending, error, change };
}

/**
 * The email nudges toggle (03 §7; since alpha A20 it covers the invitation email too, 06 §6.2):
 * saved at once, shown as the server's answer.
 */
function EmailNudges({
  api,
  me,
  onMeChanged,
  onSessionLost,
}: Pick<SettingsProps, "api" | "me" | "onMeChanged" | "onSessionLost">) {
  const { error, change } = useSettingSave((value: boolean) => saveEmailNudges(api, value), {
    onMeChanged,
    onSessionLost,
  });

  return (
    <section className="card stack" aria-labelledby="email-heading">
      <h2 id="email-heading">Emails</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={me.settings.emailNudges}
          aria-describedby="email-nudges-help email-nudges-problem"
          onChange={(event) => void change(event.target.checked)}
        />
        Email me when I&apos;m invited or it&apos;s my turn
      </label>
      <p id="email-nudges-help">
        We&apos;ll email you once for each new invitation, and when a game has waited a day for your
        move, at most once a day for each game. Every email has a link to turn this off.
      </p>
      <Problem id="email-nudges-problem" message={error} />
    </section>
  );
}

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The colour theme (07 §5, alpha A9): shown and applied at once, then saved; a failed save puts
 * the old theme back. The radios stay enabled, so focus stays on the group.
 */
function Appearance({
  api,
  me,
  onMeChanged,
  onSessionLost,
}: Pick<SettingsProps, "api" | "me" | "onMeChanged" | "onSessionLost">) {
  const { error, change } = useSettingSave((value: Theme) => saveTheme(api, value), {
    onMeChanged,
    onSessionLost,
  });
  /** The choice while it is being saved. */
  const [chosen, setChosen] = useState<Theme | null>(null);
  const [saved, setSaved] = useState(false);
  const shown = chosen ?? me.settings.theme;
  // The page shows what the radios show. The click's render applies the choice (not the handler):
  // React runs App's pending effect for the saved theme before that render, so it cannot overwrite
  // the choice afterwards. On mount both effects apply the same value.
  useEffect(() => {
    applyTheme(shown);
  }, [shown]);
  // The saved theme as of the latest render, for a save that fails after this screen has gone.
  const savedTheme = useRef(me.settings.theme);
  useEffect(() => {
    savedTheme.current = me.settings.theme;
  }, [me.settings.theme]);

  async function choose(value: Theme) {
    if (chosen !== null) return;
    setChosen(value);
    setSaved(false);
    const ok = await change(value);
    // Also when Settings has unmounted mid-save: its effect and App's no longer run, so the page
    // would keep the unsaved choice. When mounted this applies what the effect applies anyway.
    if (!ok) applyTheme(savedTheme.current);
    setSaved(ok);
    setChosen(null);
  }

  return (
    <fieldset className="card stack">
      <legend>
        <h2>Appearance</h2>
      </legend>
      {THEMES.map(({ value, label }) => (
        <label key={value} className="check">
          <input
            type="radio"
            name="theme"
            value={value}
            checked={shown === value}
            aria-describedby="theme-help theme-problem"
            onChange={() => void choose(value)}
          />
          {label}
        </label>
      ))}
      <p id="theme-help">System follows your device&apos;s light or dark setting.</p>
      <Problem id="theme-problem" message={error} />
      <p role="status">{saved ? "Theme saved" : ""}</p>
    </fieldset>
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
  const heading = useRef<HTMLHeadingElement>(null);
  /** The toggle just went away (A8-P-4): focus goes to the section's heading, not the page. */
  const focusHeading = useRef(false);

  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    heading.current?.focus();
  }, [state]);

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
    if (change === "denied") focusHeading.current = true;
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
      <h2 id="push-heading" ref={heading} tabIndex={-1}>
        Notifications
      </h2>
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
      <Appearance api={api} me={me} onMeChanged={onMeChanged} onSessionLost={onSessionLost} />
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
