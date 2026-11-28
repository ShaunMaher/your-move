/**
 * The once-per-device offer of notifications (03 §7, 07 §4): after a game is created and after an
 * invitation is accepted (A8-P-2), never at sign-in. Turning them on asks for permission from the
 * tap, as iOS requires. Either answer closes it; where the person goes next is the caller's.
 */
import type { ApiClient } from "@your-move/api-client";
import { useState } from "react";

import { Dialog } from "./Dialog.js";
import { turnOnPush } from "./push.js";

interface PushOfferProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly pushKey: string;
  readonly onDone: () => void;
}

export function PushOffer({ api, appName, pushKey, onDone }: PushOfferProps) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog title="Know when it's your turn?" onClose={onDone} dismissible={!pending}>
      <p>
        {appName} can send a notification to this device when it&apos;s your turn or a game ends.
        You can change this in Settings at any time.
      </p>
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            // Straight from the tap: the permission prompt needs it (iOS).
            void turnOnPush(api, pushKey).then(onDone);
          }}
        >
          {pending ? "Turning on…" : "Turn on notifications"}
        </button>
        <button type="button" className="button secondary" disabled={pending} onClick={onDone}>
          Not now
        </button>
      </div>
    </Dialog>
  );
}
