/**
 * Onboarding (07 §1, 06 §5): the display name, with the warning that other players see it. The age
 * confirmation and the "I'm under MIN_AGE" choice arrive with M4 (10 M2): the API has no
 * `ageAttested` field yet.
 */
import type { ApiClient } from "@your-move/api-client";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import { type Failure, type Me, saveDisplayName } from "../auth-api.js";
import { DISPLAY_NAME_MAX, graphemeCount } from "../text.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface WelcomeProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly onDone: (me: Me) => void;
  readonly onSignOut: () => void;
  /** The session is gone (401). */
  readonly onSignedOut: () => void;
}

function nameMessage(failure: Failure): string {
  switch (failure) {
    case "offline":
      return "You seem to be offline. Check your connection and try again.";
    case "rejected":
      return `That name can't be used. Names can't contain links, email addresses or long runs of digits, or look like official or staff names.`;
    default:
      return "Something went wrong. Please try again.";
  }
}

export function Welcome({ api, appName, onDone, onSignOut, onSignedOut }: WelcomeProps) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    const length = graphemeCount(name.trim());
    if (length < 1) {
      setError("Enter a display name.");
      return;
    }
    if (length > DISPLAY_NAME_MAX) {
      setError(`Display names can be up to ${String(DISPLAY_NAME_MAX)} characters.`);
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await saveDisplayName(api, name);
    if (outcome.ok) {
      onDone(outcome.data);
      return;
    }
    setPending(false);
    if (outcome.failure === "unauthenticated") onSignedOut();
    else setError(nameMessage(outcome.failure));
  }

  return (
    <Page appName={appName}>
      <h1>Welcome to {appName}</h1>
      <form className="stack" onSubmit={(event) => void submit(event)} noValidate>
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
            aria-describedby={error === null ? "display-name-hint" : "display-name-hint problem"}
          />
        </div>
        <Problem id="problem" message={error} />
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Saving…" : "Continue"}
        </button>
      </form>
      <p>
        Not you?{" "}
        <button type="button" className="link" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    </Page>
  );
}
