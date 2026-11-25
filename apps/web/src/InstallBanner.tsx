import { useState } from "react";

import {
  dismissInstallBanner,
  installBannerDismissed,
  isIosSafari,
  isStandalone,
} from "./install.js";
import { Link } from "./router.js";

/**
 * A dismissible nudge to add the app to the Home Screen, only for Safari on iOS outside the
 * installed app (07 §4). It sits in the page flow, so it never covers a screen's content.
 */
export function InstallBanner({ appName }: { readonly appName: string }) {
  const [hidden, setHidden] = useState(
    () => installBannerDismissed() || isStandalone() || !isIosSafari(),
  );
  if (hidden) return null;
  return (
    <aside className="install-banner" aria-label="Add to Home Screen">
      <p>Add {appName} to your Home Screen to open it like an app.</p>
      <Link to="/install" className="button">
        Show me how
      </Link>
      <button
        type="button"
        className="button secondary"
        onClick={() => {
          dismissInstallBanner();
          setHidden(true);
          // The button is gone: focus moves to the screen's heading, as after any move.
          document.querySelector("h1")?.focus({ preventScroll: true });
        }}
      >
        Dismiss
      </button>
    </aside>
  );
}
