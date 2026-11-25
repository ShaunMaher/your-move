import { useEffect, useState } from "react";

import { registerServiceWorker, type UpdateWatch } from "./sw-register.js";

/** "New version available — reload" when the service worker has an update waiting (07 §4). */
export function UpdateToast() {
  const [update, setUpdate] = useState<UpdateWatch | null>(null);
  useEffect(() => {
    registerServiceWorker(setUpdate);
  }, []);
  if (update === null) return null;
  return (
    <div className="toast" role="status">
      <span>New version available.</span>
      <button type="button" className="button" onClick={update.apply}>
        Reload
      </button>
    </div>
  );
}
