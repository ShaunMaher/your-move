import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { type ClientConfig, type Me, loadConfig, loadSession } from "./auth-api.js";
import { applyAppName } from "./document-meta.js";
import { InstallBanner } from "./InstallBanner.js";
import { dropPushSubscription, resyncPush } from "./push.js";
import {
  clearReturnPath,
  isDestination,
  peekReturnPath,
  rememberReturnPath,
} from "./return-path.js";
import { navigate, usePath } from "./router.js";
import { Game } from "./screens/Game.js";
import { Home } from "./screens/Home.js";
import { Install } from "./screens/Install.js";
import { NewGame } from "./screens/NewGame.js";
import { Settings } from "./screens/Settings.js";
import { SignIn } from "./screens/SignIn.js";
import { Loading, NotFound, Unreachable } from "./screens/Status.js";
import { Welcome } from "./screens/Welcome.js";
import {
  announceSignedIn,
  announceSignedOut,
  clearClientState,
  clearGameState,
  onBecameVisible,
  watchSession,
} from "./session-sync.js";
import { UpdateToast } from "./UpdateToast.js";

type Boot =
  | { readonly status: "loading" }
  | { readonly status: "unreachable"; readonly offline: boolean }
  | {
      readonly status: "ready";
      readonly config: ClientConfig;
      readonly me: Me | null;
      /** Where a signed-out visit was headed, taken when the person signs in (never at render). */
      readonly returnTo: string | null;
    };

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

/** The game id of a `/g/:id` path, or `null` for any other path. */
function gameIdOf(path: string): string | null {
  const encoded = /^\/g\/([^/]+)$/u.exec(path)?.[1];
  if (encoded === undefined) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
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
        setBoot({ status: "ready", config: config.data, me: session.data, returnTo: null });
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
  const place = boot.status === "ready" ? placeFor(me, path, boot.returnTo) : path;
  // Arrived at a real destination: the remembered path has been used, so state forgets it too
  // (adjusting state during render, from state and props only, never from storage).
  if (boot.status === "ready" && me !== null && boot.returnTo !== null) {
    if (place === path && isDestination(path)) setBoot({ ...boot, returnTo: null });
  }
  const gameId = gameIdOf(place);
  useEffect(() => {
    if (boot.status !== "ready") return;
    if (me === null) {
      // No session: nothing of a previous person's may remain, this device's push subscription
      // included (06 §4; the server's copy went with the session). A signed-out visit to a page
      // is remembered, so signing in lands back there.
      clearGameState();
      dropPushSubscription();
      if (path !== "/signin") rememberReturnPath(path);
    } else if (place === path && isDestination(path)) {
      // Arrived at a real destination (not a sign-in screen on the way): the memory is spent.
      clearReturnPath();
    }
    if (place !== path) navigate(place, { replace: true });
  }, [boot.status, me, place, path]);

  // The session ended here or in another tab or device: clear what the app keeps about the
  // person and show the sign-in screen (08 §2).
  const endSession = useCallback((announce: boolean) => {
    clearClientState();
    if (announce) announceSignedOut();
    navigate("/signin", { replace: true });
    setBoot((current) =>
      current.status === "ready" ? { ...current, me: null, returnTo: null } : current,
    );
  }, []);
  // Asks the server who the session is now. Nobody ends it here; a different person ends it for
  // this tab as surely (their games are not for this screen), and the app starts over as them.
  const meId = me?.id ?? null;
  useEffect(() => {
    if (meId === null) return undefined;
    let live = true;
    const recheck = () => {
      void loadSession(api).then((session) => {
        if (!live || !session.ok) return;
        if (session.data === null) endSession(false);
        else if (session.data.id !== meId) {
          clearClientState();
          retry();
        }
      });
    };
    const stopChannel = watchSession({
      onSignedOut: () => {
        endSession(false);
      },
      onSignedIn: recheck,
    });
    const stopVisible = onBecameVisible(recheck);
    return () => {
      live = false;
      stopChannel();
      stopVisible();
    };
  }, [meId, api, endSession, retry]);

  // At each launch with a session, this device's push subscription is saved again: Safari has no
  // `pushsubscriptionchange`, and the session may be a new one (07 §4).
  const pushKey = config?.vapidPublicKey;
  useEffect(() => {
    if (meId !== null) void resyncPush(api, pushKey);
  }, [meId, api, pushKey]);

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

  // Onboarding is done: the person is the same, with a name now. The remembered path is read here,
  // in the handler, so it survives a reload during Welcome. A late reply for someone who is no
  // longer signed in (another account took over meanwhile) is dropped.
  const setMe = (next: Me) => {
    const returnTo = peekReturnPath();
    setBoot((current) =>
      current.status === "ready" && current.me?.id === next.id
        ? { ...current, me: next, returnTo }
        : current,
    );
  };
  // A change on the Settings screen: the same person, nothing else moves.
  const updateMe = (next: Me) => {
    setBoot((current) =>
      current.status === "ready" && current.me?.id === next.id ? { ...current, me: next } : current,
    );
  };
  const signedInHere = (next: Me) => {
    const returnTo = peekReturnPath();
    setBoot((current) =>
      current.status === "ready" ? { ...current, me: next, returnTo } : current,
    );
    announceSignedIn();
  };
  const signedOut = () => {
    endSession(true);
  };
  // A game call answered 401: the session ended elsewhere, so end it here too.
  const sessionLost = useCallback(() => {
    endSession(false);
  }, [endSession]);

  let screen;
  if (boot.status === "loading") screen = <Loading />;
  else if (boot.status === "unreachable") {
    screen = <Unreachable offline={boot.offline} onRetry={retry} />;
  } else if (me === null) {
    screen = <SignIn api={api} appName={boot.config.appName} onSignedIn={signedInHere} />;
  } else if (place === "/welcome") {
    screen = (
      <Welcome api={api} appName={boot.config.appName} onDone={setMe} onSignedOut={signedOut} />
    );
  } else if (place === "/") {
    screen = <Home api={api} appName={boot.config.appName} me={me} onSessionLost={sessionLost} />;
  } else if (place === "/new") {
    screen = (
      <NewGame
        api={api}
        appName={boot.config.appName}
        pushKey={pushKey}
        ownEmail={me.email ?? ""}
        onSessionLost={sessionLost}
      />
    );
  } else if (gameId !== null) {
    screen = (
      <Game
        key={gameId}
        api={api}
        appName={boot.config.appName}
        pushKey={pushKey}
        id={gameId}
        onSessionLost={sessionLost}
      />
    );
  } else if (place === "/install") {
    screen = <Install appName={boot.config.appName} />;
  } else if (place === "/settings") {
    screen = (
      <Settings
        api={api}
        appName={boot.config.appName}
        me={me}
        pushKey={pushKey}
        onMeChanged={updateMe}
        onSessionLost={sessionLost}
        onSignedOut={signedOut}
      />
    );
  } else screen = <NotFound appName={boot.config.appName} />;

  // Signed in and onboarded, on a screen that isn't a game's, the guide or sign-in (07 §4).
  const banner =
    boot.status === "ready" &&
    me !== null &&
    (place === "/" || place === "/new" || place === "/settings");
  return (
    <>
      {banner && <InstallBanner appName={boot.config.appName} />}
      {screen}
      <UpdateToast />
    </>
  );
}
