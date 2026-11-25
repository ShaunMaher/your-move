/**
 * The colour theme (07 §5): `data-theme` on the root element is what the stylesheet reads, absent
 * for "system". The last choice is kept per device so a launch shows it before `/api/v1/me`
 * answers; it holds no user data and survives sign-out (06 §4).
 */
export type Theme = "system" | "light" | "dark";

const KEY = "ym.theme";

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/** The theme this device last showed. Storage that throws, or holds anything odd, is "system". */
export function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(KEY);
    return isTheme(value) ? value : "system";
  } catch {
    return "system";
  }
}

function show(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** Shows the theme this device last used; run when the app's module starts. */
export function applyStoredTheme(): void {
  show(storedTheme());
}

/** Shows `theme` and remembers it for the next launch. */
export function applyTheme(theme: Theme): void {
  show(theme);
  try {
    if (storedTheme() !== theme) window.localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable: the choice holds for this page view and the server has it.
  }
}
