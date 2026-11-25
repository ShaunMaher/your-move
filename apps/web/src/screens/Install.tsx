import type { ReactNode } from "react";

import { isStandalone } from "../install.js";
import { Link } from "../router.js";
import { Page } from "./Page.js";

/** A drawn glyph: decorative (the step's words say what it looks like), so hidden from readers. */
function Glyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      className="glyph"
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A square open at the top with an arrow rising out of it. */
const ShareGlyph = () => (
  <Glyph>
    <path d="M10 13H7v15h18V13h-3" />
    <path d="M16 20V4M10 10l6-6 6 6" />
  </Glyph>
);

/** A rounded square with a plus in it. */
const AddGlyph = () => (
  <Glyph>
    <rect x="5" y="5" width="22" height="22" rx="5" />
    <path d="M16 11v10M11 16h10" />
  </Glyph>
);

/** Three dots in a column. */
const MenuGlyph = () => (
  <Glyph>
    <circle cx="16" cy="7" r="1.5" fill="currentColor" />
    <circle cx="16" cy="16" r="1.5" fill="currentColor" />
    <circle cx="16" cy="25" r="1.5" fill="currentColor" />
  </Glyph>
);

/** The "Add to Home Screen" guide (07 §1, §4). */
export function Install({ appName }: { readonly appName: string }) {
  const installed = isStandalone();
  return (
    <Page appName={appName} nav={<Link to="/">Home</Link>}>
      <h1 tabIndex={-1}>Add to Home Screen</h1>
      {installed ? (
        <p role="status">
          You&apos;re already using {appName} from your Home Screen. Nothing more to do.
        </p>
      ) : (
        <>
          <p>
            {appName} works best from your Home Screen: it opens full screen, with its own icon.
          </p>
          <section className="card stack" aria-labelledby="ios-heading">
            <h2 id="ios-heading">iPhone and iPad (Safari)</h2>
            <ol className="steps">
              <li>
                <ShareGlyph />
                <span>
                  Tap the <strong>Share</strong> button: a square with an arrow pointing up, at the
                  bottom or top of Safari.
                </span>
              </li>
              <li>
                <AddGlyph />
                <span>
                  Scroll down and tap <strong>Add to Home Screen</strong>: a square with a plus in
                  it.
                </span>
              </li>
              <li>
                <span>
                  Tap <strong>Add</strong>, at the top right. {appName} now has an icon on your Home
                  Screen.
                </span>
              </li>
            </ol>
            <p>Other browsers on iPhone can&apos;t do this: open this page in Safari.</p>
          </section>
          <section className="card stack" aria-labelledby="android-heading">
            <h2 id="android-heading">Android (Chrome)</h2>
            <ol className="steps">
              <li>
                <MenuGlyph />
                <span>
                  Tap the <strong>menu</strong> button: three dots in a column, at the top right.
                </span>
              </li>
              <li>
                <span>
                  Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>), then
                  confirm.
                </span>
              </li>
            </ol>
          </section>
        </>
      )}
    </Page>
  );
}
