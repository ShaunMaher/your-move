import { useEffect, useState } from "react";

import { registerServiceWorker, type UpdateWatch } from "./sw-register.js";

/**
 * "New version available — reload" when the service worker has an update waiting (07 §4). The
 * live region is always in the page, so a screen reader announces the toast when it is filled in.
 */
export function UpdateToast() {
  const [update, setUpdate] = useState<UpdateWatch | null>(null);
  useEffect(() => {
    registerServiceWorker(setUpdate);
  }, []);
  return (
    <div role="status">
      {update !== null && (
        <>
          <div className="toast">
            <span>New version available.</span>
            <button type="button" className="button" onClick={update.apply}>
              Reload
            </button>
          </div>
          {/* Room under the page's content, so the toast never covers its last line. */}
          <div className="toast-room" aria-hidden="true" />
        </>
      )}
    </div>
  );
}
