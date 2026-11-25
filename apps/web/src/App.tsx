import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useState } from "react";

import { type ClientConfig, type Me, loadConfig, loadSession, signOut } from "./auth-api.js";
import { applyAppName } from "./document-meta.js";
import { navigate, usePath } from "./router.js";
import { Home } from "./screens/Home.js";
import { Settings } from "./screens/Settings.js";
import { SignIn } from "./screens/SignIn.js";
import { Loading, NotFound, Unreachable } from "./screens/Status.js";
import { Welcome } from "./screens/Welcome.js";
import { UpdateToast } from "./UpdateToast.js";

type Boot =
  | { readonly status: "loading" }
  | { readonly status: "unreachable"; readonly offline: boolean }
  | { readonly status: "ready"; readonly config: ClientConfig; readonly me: Me | null };

interface AppProps {
  readonly api: ApiClient;
}

/** Where the person belongs given who they are (06 §2): sign-in, onboarding, or the app. */
function placeFor(me: Me | null, path: string): string {
  if (me === null) return "/signin";
  if (me.needsOnboarding) return "/welcome";
  return path === "/signin" || path === "/welcome" ? "/" : path;
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
  const place = boot.status === "ready" ? placeFor(me, path) : path;
  useEffect(() => {
    if (boot.status === "ready" && place !== path) navigate(place, { replace: true });
  }, [boot.status, place, path]);

  const setMe = (next: Me | null) => {
    setBoot((current) => (current.status === "ready" ? { ...current, me: next } : current));
  };

  const doSignOut = () => {
    // A failed request still leaves the person signed in, so only an answer ends the session
    // here; a 401 means it was already over.
    void signOut(api).then((outcome) => {
      if (outcome.ok || outcome.failure === "unauthenticated") setMe(null);
    });
  };

  let screen;
  if (boot.status === "loading") screen = <Loading />;
  else if (boot.status === "unreachable") {
    screen = <Unreachable offline={boot.offline} onRetry={retry} />;
  } else if (me === null) {
    screen = <SignIn api={api} appName={boot.config.appName} onSignedIn={setMe} />;
  } else if (place === "/welcome") {
    screen = (
      <Welcome
        api={api}
        appName={boot.config.appName}
        onDone={setMe}
        onSignOut={doSignOut}
        onSignedOut={() => {
          setMe(null);
        }}
      />
    );
  } else if (place === "/") {
    screen = <Home appName={boot.config.appName} me={me} />;
  } else if (place === "/settings") {
    screen = (
      <Settings
        api={api}
        appName={boot.config.appName}
        me={me}
        onSignOut={doSignOut}
        onSignedOut={() => {
          setMe(null);
        }}
      />
    );
  } else screen = <NotFound appName={boot.config.appName} />;

  return (
    <>
      {screen}
      <UpdateToast />
    </>
  );
}
