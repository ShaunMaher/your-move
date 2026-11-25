import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { type ClientConfig, type Me, loadConfig, loadSession } from "./auth-api.js";
import { applyAppName } from "./document-meta.js";
import { clearReturnPath, peekReturnPath, rememberReturnPath } from "./return-path.js";
import { navigate, usePath } from "./router.js";
import { Home } from "./screens/Home.js";
import { Settings } from "./screens/Settings.js";
import { SignIn } from "./screens/SignIn.js";
import { Loading, NotFound, Unreachable } from "./screens/Status.js";
import { Welcome } from "./screens/Welcome.js";
import {
  announceSignedOut,
  clearClientState,
  onBecameVisible,
  watchSignedOut,
} from "./session-sync.js";
import { UpdateToast } from "./UpdateToast.js";

type Boot =
  | { readonly status: "loading" }
  | { readonly status: "unreachable"; readonly offline: boolean }
  | { readonly status: "ready"; readonly config: ClientConfig; readonly me: Me | null };

interface AppProps {
  readonly api: ApiClient;
}

/**
 * Where the person belongs given who they are (06 §2): sign-in, onboarding, or the app (the page
 * a signed-out visit was headed for, when there is one, else home).
 */
function placeFor(me: Me | null, path: string, returnTo: string | null): string {
  if (me === null) return "/signin";
  if (me.needsOnboarding) return "/welcome";
  return path === "/signin" || path === "/welcome" ? (returnTo ?? "/") : path;
}

/**
 * The app: the instance's name and the signed-in person from the API, then the screen for where
 * they are in the sign-in flow. Everything goes through the typed API client (07).
 */
export function App({ api }: AppProps) {
  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const path = usePath();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadConfig(api), loadSession(api)]).then(([config, session]) => {
      if (cancelled) return;
      if (config.ok && session.ok) {
        setBoot({ status: "ready", config: config.data, me: session.data });
      } else {
        const offline = [config, session].some((r) => !r.ok && r.failure === "offline");
        setBoot({ status: "unreachable", offline });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retry = useCallback(() => {
    setBoot({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  // Offline at launch: try again as soon as the connection is back.
  const unreachable = boot.status === "unreachable";
  useEffect(() => {
    if (!unreachable) return undefined;
    window.addEventListener("online", retry);
    return () => {
      window.removeEventListener("online", retry);
    };
  }, [unreachable, retry]);

  const config = boot.status === "ready" ? boot.config : null;
  useEffect(() => {
    if (config !== null) applyAppName(config.appName, config.appShortName);
  }, [config]);

  const me = boot.status === "ready" ? boot.me : null;
  const place = boot.status === "ready" ? placeFor(me, path, peekReturnPath()) : path;
  useEffect(() => {
    if (boot.status !== "ready") return;
    // A signed-out visit to a page is remembered, so signing in lands back there.
    if (me === null && path !== "/signin") rememberReturnPath(path);
    if (me !== null && place === path) clearReturnPath();
    if (place !== path) navigate(place, { replace: true });
  }, [boot.status, me, place, path]);

  // The session ended here or in another tab or device: clear what the app keeps about the
  // person and show the sign-in screen (08 §2).
  const endSession = useCallback((announce: boolean) => {
    clearClientState();
    if (announce) announceSignedOut();
    navigate("/signin", { replace: true });
    setBoot((current) => (current.status === "ready" ? { ...current, me: null } : current));
  }, []);
  const signedIn = me !== null;
  useEffect(() => {
    if (!signedIn) return undefined;
    const stopChannel = watchSignedOut(() => {
      endSession(false);
    });
    const stopVisible = onBecameVisible(() => {
      void loadSession(api).then((session) => {
        if (session.ok && session.data === null) endSession(false);
      });
    });
    return () => {
      stopChannel();
      stopVisible();
    };
  }, [signedIn, api, endSession]);

  // After a move to another screen, focus goes to its heading so a screen reader starts reading
  // there. A field the new screen has focused itself (its effects run first) keeps focus.
  const screenKey = boot.status === "ready" ? (me === null ? "signin" : place) : boot.status;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = screenKey;
    if (previous === null || previous === "loading" || previous === screenKey) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector("h1")?.focus({ preventScroll: true });
    }
  }, [screenKey]);

  const setMe = (next: Me) => {
    setBoot((current) => (current.status === "ready" ? { ...current, me: next } : current));
  };
  const signedOut = () => {
    endSession(true);
  };

  let screen;
  if (boot.status === "loading") screen = <Loading />;
  else if (boot.status === "unreachable") {
    screen = <Unreachable offline={boot.offline} onRetry={retry} />;
  } else if (me === null) {
    screen = <SignIn api={api} appName={boot.config.appName} onSignedIn={setMe} />;
  } else if (place === "/welcome") {
    screen = (
      <Welcome api={api} appName={boot.config.appName} onDone={setMe} onSignedOut={signedOut} />
    );
  } else if (place === "/") {
    screen = <Home appName={boot.config.appName} me={me} />;
  } else if (place === "/settings") {
    screen = <Settings api={api} appName={boot.config.appName} me={me} onSignedOut={signedOut} />;
  } else screen = <NotFound appName={boot.config.appName} />;

  return (
    <>
      {screen}
      <UpdateToast />
    </>
  );
}
