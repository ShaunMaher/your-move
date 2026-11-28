/**
 * The `theme` setting (docs/spec/07-frontend.md §5, 05 `PATCH /api/v1/me`; alpha A9), end to end
 * on the real app and a real SQLite database.
 */
import { afterEach, describe, expect, it } from "vitest";

import { call, gameHarness, signUp } from "./games-support.js";
import type { Harness } from "./test-harness.js";

let h: Harness;
afterEach(() => {
  h.close();
});

interface Me {
  readonly settings: { readonly emailNudges: boolean; readonly theme: string };
}

describe("the theme setting (PATCH /api/v1/me)", () => {
  it("is system by default, takes the three values, and leaves other settings alone", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings.theme).toBe("system");
    await call(h, ada, "PATCH", "/api/v1/me", { settings: { emailNudges: true } });
    for (const theme of ["dark", "light", "system"]) {
      const result = await call<Me>(h, ada, "PATCH", "/api/v1/me", { settings: { theme } });
      expect(result.status).toBe(200);
      expect(result.body.settings).toMatchObject({ theme, emailNudges: true });
      expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings.theme).toBe(theme);
    }
    // Changing the nudges leaves the theme as it was.
    await call(h, ada, "PATCH", "/api/v1/me", { settings: { theme: "dark" } });
    const off = await call<Me>(h, ada, "PATCH", "/api/v1/me", { settings: { emailNudges: false } });
    expect(off.body.settings).toMatchObject({ theme: "dark", emailNudges: false });
  });

  it("refuses a value outside the three and changes nothing", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    await call(h, ada, "PATCH", "/api/v1/me", { settings: { theme: "dark" } });
    for (const theme of ["blue", "", 1, null, "Dark"]) {
      expect((await call(h, ada, "PATCH", "/api/v1/me", { settings: { theme } })).status).toBe(400);
    }
    expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings.theme).toBe("dark");
  });

  it("reads each stored value on its own: a bad theme falls back without resetting the nudges", async () => {
    h = gameHarness();
    const ada = await signUp(h, "Ada");
    h.exec(
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ emailNudges: true, theme: "purple" }),
      ada.id,
    );
    expect((await call<Me>(h, ada, "GET", "/api/v1/me")).body.settings).toMatchObject({
      emailNudges: true,
      theme: "system",
    });
  });
});
