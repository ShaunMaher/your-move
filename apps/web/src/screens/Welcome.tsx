/**
 * Onboarding (07 §1, 06 §5): the display name, with the warning that other players see it, and the
 * age confirmation, with an explicit "I'm under MIN_AGE" choice. A step already done isn't asked
 * again, so an account re-prompted after a `MIN_AGE` rise sees only the age step, addressed to the
 * account holder: a child may be holding a parent's phone (Q20).
 */
import type { ApiClient } from "@your-move/api-client";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import { type Failure, leaveUnderAge, type Me, saveOnboarding } from "../auth-api.js";
import { Link } from "../router.js";
import { DISPLAY_NAME_MAX, graphemeCount } from "../text.js";
import { useSignOut } from "../use-sign-out.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface WelcomeProps {
  readonly api: ApiClient;
  readonly appName: string;
  /** `MIN_AGE`, from the instance's config. */
  readonly minAge: number;
  readonly me: Me;
  readonly onDone: (me: Me) => void;
  /** The session is gone (401). */
  readonly onSignedOut: () => void;
  /** "I'm under MIN_AGE" was answered: the session is over. */
  readonly onUnderAge: () => void;
}

const SOMETHING_WRONG = "Something went wrong. Please try again.";
const OFFLINE = "You seem to be offline. Check your connection and try again.";

function saveMessage(failure: Failure): string {
  switch (failure) {
    case "offline":
      return OFFLINE;
    case "rejected":
      return `That name can't be used. Names can't contain links, email addresses or long runs of digits, or look like official or staff names.`;
    default:
      return SOMETHING_WRONG;
  }
}

export function Welcome({
  api,
  appName,
  minAge,
  me,
  onDone,
  onSignedOut,
  onUnderAge,
}: WelcomeProps) {
  const askName = me.displayName === null;
  const askAge = !me.ageAttested;
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const signOut = useSignOut(api, onSignedOut);
  const age = String(minAge);

  useEffect(() => {
    field.current?.focus();
  }, []);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (pending || leaving) return;
    const length = graphemeCount(name.trim());
    if (askName && length < 1) {
      setError("Enter a display name.");
      return;
    }
    if (askName && length > DISPLAY_NAME_MAX) {
      setError(`Display names can be up to ${String(DISPLAY_NAME_MAX)} characters.`);
      return;
    }
    if (askAge && !confirmed) {
      setError(`Confirm you're ${age} or older to continue.`);
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await saveOnboarding(api, {
      ...(askName ? { displayName: name } : {}),
      ...(askAge ? { ageAttested: true as const } : {}),
    });
    if (outcome.ok) {
      onDone(outcome.data);
      return;
    }
    setPending(false);
    if (outcome.failure === "unauthenticated") onSignedOut();
    else setError(saveMessage(outcome.failure));
  }

  async function underAge() {
    if (pending || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    const outcome = await leaveUnderAge(api);
    if (outcome.ok) {
      onUnderAge();
      return;
    }
    setLeaving(false);
    if (outcome.failure === "unauthenticated") onSignedOut();
    else setLeaveError(outcome.failure === "offline" ? OFFLINE : SOMETHING_WRONG);
  }

  const described = (hint: string) => (error === null ? hint : `${hint} problem`);
  return (
    <Page appName={appName}>
      <h1 tabIndex={-1}>{askName ? `Welcome to ${appName}` : "Confirm your age"}</h1>
      <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
        {askName && (
          <div className="field">
            <label htmlFor="display-name">Display name</label>
            <p id="display-name-hint" className="hint">
              Other players will see this. Don&apos;t use your full name.
            </p>
            <input
              ref={field}
              id="display-name"
              name="displayName"
              type="text"
              autoComplete="nickname"
              required
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={described("display-name-hint")}
            />
          </div>
        )}
        {askAge && (
          <div className="field">
            <p id="age-hint" className="hint">
              {askName
                ? `${appName} is for people aged ${age} or older.`
                : `Please confirm you, the account holder, are ${age} or older.`}
            </p>
            <label className="check">
              <input
                ref={askName ? undefined : field}
                type="checkbox"
                name="ageAttested"
                checked={confirmed}
                onChange={(event) => {
                  setConfirmed(event.target.checked);
                }}
                aria-describedby={described("age-hint")}
              />
              <span className="check-text">I&apos;m {age} or older</span>
            </label>
          </div>
        )}
        <Problem id="problem" message={error} />
        <button type="submit" className="button" disabled={pending || leaving}>
          {pending ? "Saving…" : "Continue"}
        </button>
      </form>
      {askAge && (
        <>
          <button
            type="button"
            className="button secondary"
            disabled={pending || leaving}
            onClick={() => void underAge()}
          >
            {leaving ? "Signing out…" : `I'm under ${age}`}
          </button>
          <Problem id="under-age-problem" message={leaveError} />
        </>
      )}
      <p className="aside">
        Not you?
        <button type="button" className="link" disabled={signOut.pending} onClick={signOut.signOut}>
          {signOut.pending ? "Signing out…" : "Sign out"}
        </button>
      </p>
      <Problem id="signout-problem" message={signOut.error} />
      <p className="aside">
        <Link to="/privacy">Privacy</Link>
      </p>
    </Page>
  );
}

interface UnderAgeNoticeProps {
  readonly appName: string;
  readonly onDone: () => void;
}

/** After "I'm under MIN_AGE" (06 §5): the session is over either way, and this says what next. */
export function UnderAgeNotice({ appName, onDone }: UnderAgeNoticeProps) {
  return (
    <Page appName={appName}>
      <h1 tabIndex={-1}>You&apos;re signed out</h1>
      <p role="status">Ask a parent or carer to sign in and play with you on their account.</p>
      <button type="button" className="button" onClick={onDone}>
        Back to sign in
      </button>
    </Page>
  );
}
