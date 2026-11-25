/**
 * What the install guide needs to know about this browser (07 §4): whether it is Safari on iOS or
 * iPadOS, whether the app already runs from the Home Screen, and whether the banner was dismissed.
 */
const DISMISSED_KEY = "ym.install-dismissed";

/** Tokens third-party iOS browsers and in-app browsers add; their menus differ from Safari's. */
const OTHER_BROWSERS =
  /CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo|FBAN|FBAV|Instagram|Line\//u;

/** Safari on iPhone, iPod or iPad (iPadOS reports a Mac, which is told apart by touch support). */
export function isIosSafari(): boolean {
  const { userAgent, platform, maxTouchPoints } = window.navigator;
  const ios =
    /iPhone|iPad|iPod/u.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  return ios && userAgent.includes("Safari/") && !OTHER_BROWSERS.test(userAgent);
}

/** Whether the app is running from the Home Screen (or as an installed app) rather than in a tab. */
export function isStandalone(): boolean {
  const { navigator } = window;
  if ((navigator as { standalone?: boolean }).standalone === true) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/** Whether this device's person dismissed the banner. Storage that throws counts as "not yet". */
export function installBannerDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissInstallBanner(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the banner is gone for this page view and may return on the next.
  }
}
