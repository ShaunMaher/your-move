/**
 * Email entry, then code entry, on one screen (07 §1, 06 §2). Whatever the address, the screens
 * and messages are the same: the API never says whether it has an account (06 §6.1), and neither
 * does this.
 */
import type { ApiClient } from "@your-move/api-client";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";

import { type Failure, type Me, requestCode, verifyCode } from "../auth-api.js";
import { Link } from "../router.js";
import { CODE_LENGTH, cleanCode, looksLikeEmail } from "../text.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface SignInProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly onSignedIn: (me: Me) => void;
}

const OFFLINE = "You seem to be offline. Check your connection and try again.";

/** What to say when asking for a code fails. */
function requestMessage(failure: Failure): string {
  switch (failure) {
    case "offline":
      return OFFLINE;
    case "rate-limited":
      return "Too many attempts from your connection. Please wait a while and try again.";
    case "rejected":
      // The server's own check of the address shape failed (or, rarely, its network address was
      // missing). The answer depends on the address's shape only, never on whether it has an
      // account, so it can say so without leaking anything (06 §6.1).
      return "Check your email address. If it looks right, please try again later.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** What to say when a code is refused: the same for wrong, expired and used codes (05). */
function verifyMessage(failure: Failure): string {
  switch (failure) {
    case "offline":
      return OFFLINE;
    case "rate-limited":
      return "Too many tries. Please wait a while before trying again.";
    case "invalid-code":
    case "rejected":
      return "That code didn't work. It may have expired or been used already. Check it, or send a new one.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export function SignIn({ api, appName, onSignedIn }: SignInProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // Each step starts with its one field focused (the keyboard and code autofill are then ready).
  useEffect(() => {
    field.current?.focus();
  }, [step]);

  async function sendCode(then: () => void, announce: string | null) {
    setPending(true);
    setError(null);
    setNotice(null);
    const outcome = await requestCode(api, email.trim());
    setPending(false);
    if (!outcome.ok) {
      setError(requestMessage(outcome.failure));
      return;
    }
    setNotice(announce);
    then();
  }

  function submitEmail(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    if (!looksLikeEmail(email)) {
      setError("Enter your email address, like name@example.org.");
      return;
    }
    void sendCode(() => {
      setCode("");
      setStep("code");
    }, null);
  }

  async function submitCode(event: SyntheticEvent) {
    event.preventDefault();
    if (pending) return;
    if (code.length !== CODE_LENGTH) {
      setError(`Enter the ${String(CODE_LENGTH)}-digit code from the email.`);
      return;
    }
    setPending(true);
    setError(null);
    setNotice(null);
    const outcome = await verifyCode(api, email.trim(), code);
    if (outcome.ok) {
      onSignedIn(outcome.data);
      return;
    }
    setPending(false);
    setError(verifyMessage(outcome.failure));
  }

  function resend() {
    if (pending) return;
    void sendCode(() => {
      setCode("");
      field.current?.focus();
    }, "We've sent another code.");
  }

  function changeAddress() {
    setStep("email");
    setError(null);
    setNotice(null);
  }

  return (
    <Page appName={appName}>
      <h1 tabIndex={-1}>Sign in</h1>
      {step === "email" ? (
        <form className="stack" onSubmit={submitEmail} noValidate>
          <p>Enter your email address and we&apos;ll email you a code. No password needed.</p>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input
              ref={field}
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={error === null ? undefined : "problem"}
            />
          </div>
          <Problem id="problem" message={error} />
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Sending…" : "Email me a code"}
          </button>
        </form>
      ) : (
        <form className="stack" onSubmit={(event) => void submitCode(event)} noValidate>
          <p>
            Check your email for an {String(CODE_LENGTH)}-digit code. It expires in 10 minutes.
            Nothing there? Look in your spam folder, or send a new code.
          </p>
          <div className="field">
            <label htmlFor="code">Sign-in code</label>
            <input
              ref={field}
              id="code"
              name="code"
              className="code-input"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(event) => {
                setCode(cleanCode(event.target.value));
              }}
              aria-invalid={error === null ? undefined : true}
              aria-describedby={error === null ? undefined : "problem"}
            />
          </div>
          <Problem id="problem" message={error} />
          <div role="status">{notice}</div>
          <button type="submit" className="button" disabled={pending}>
            {pending ? "Checking…" : "Sign in"}
          </button>
          <div className="row">
            <button type="button" className="button secondary" onClick={resend} disabled={pending}>
              Send a new code
            </button>
            <button type="button" className="button secondary" onClick={changeAddress}>
              Use a different address
            </button>
          </div>
        </form>
      )}
      {step === "email" && (
        // On the email step only: leaving the code step would lose the typed address (A21-P-8).
        <p className="aside">
          <Link to="/privacy">Privacy</Link>
        </p>
      )}
    </Page>
  );
}
