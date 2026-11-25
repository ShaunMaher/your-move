import type { ApiClient } from "@your-move/api-client";
import { useState } from "react";

import { signOut } from "./auth-api.js";

const SIGN_OUT_FAILED = "Couldn't sign out. You're still signed in. Try again.";

/**
 * Plain sign-out for the screens that offer it (Settings, Welcome). Only an answer ends the
 * session here: a 401 means it was already over, and anything else (offline, 429, a server
 * error) leaves the person signed in, so it says so.
 */
export function useSignOut(api: ApiClient, onSignedOut: () => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (pending) return;
    setPending(true);
    setError(null);
    const outcome = await signOut(api);
    if (outcome.ok || outcome.failure === "unauthenticated") {
      onSignedOut();
      return;
    }
    setPending(false);
    setError(SIGN_OUT_FAILED);
  }

  return {
    pending,
    error,
    signOut: () => {
      void run();
    },
  };
}
