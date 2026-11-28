/** A join link's token on its way through the app (07 §1 `/join`, 06 §6.8, 08 T24). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { captureJoinFragment, clearJoinToken, keptJoinToken } from "./join-token.js";
import { clearClientState, clearGameState } from "./session-sync.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";

beforeEach(() => {
  clearJoinToken();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  clearJoinToken();
});

describe("captureJoinFragment", () => {
  it("takes the token out of the address bar and keeps it in sessionStorage", () => {
    window.history.replaceState(null, "", `/join#${TOKEN}`);
    const entries = window.history.length;
    captureJoinFragment();
    expect(window.location.href).toBe(`${window.location.origin}/join`);
    expect(window.location.hash).toBe("");
    // Replaced, not pushed: Back never returns to the address with the token.
    expect(window.history.length).toBe(entries);
    expect(keptJoinToken()).toBe(TOKEN);
    expect(window.sessionStorage.getItem("ym.join")).toBe(`/join#${TOKEN}`);
  });

  it("keeps nothing for a fragment that isn't a token, and forgets an older one", () => {
    window.history.replaceState(null, "", `/join#${TOKEN}`);
    captureJoinFragment();
    for (const fragment of ["#short", `#${TOKEN}x`, `#${TOKEN.slice(1)}/`, "#%41"]) {
      window.history.replaceState(null, "", `/join${fragment}`);
      captureJoinFragment();
      expect(window.location.hash).toBe("");
      expect(keptJoinToken()).toBeNull();
    }
  });

  it("does nothing on any other page, or on /join without a fragment", () => {
    window.history.replaceState(null, "", `/join#${TOKEN}`);
    captureJoinFragment();
    for (const path of ["/join", `/g/1#${TOKEN}`, `/joined#${TOKEN}`, `/settings#x`]) {
      window.history.replaceState(null, "", path);
      captureJoinFragment();
      expect(`${window.location.pathname}${window.location.hash}`).toBe(path);
    }
    expect(keptJoinToken()).toBe(TOKEN);
  });
});

describe("keptJoinToken", () => {
  it("refuses a stored value that isn't a join link's path and fragment", () => {
    for (const value of [
      TOKEN,
      `/g/1#${TOKEN}`,
      `//evil.example/join#${TOKEN}`,
      `/join#${TOKEN}?`,
    ]) {
      window.sessionStorage.setItem("ym.join", value);
      expect(keptJoinToken()).toBeNull();
    }
  });

  it("is cleared when the session ends in the tab, not when a signed-out visit starts", () => {
    window.history.replaceState(null, "", `/join#${TOKEN}`);
    captureJoinFragment();
    clearGameState();
    expect(keptJoinToken()).toBe(TOKEN);
    clearClientState();
    expect(keptJoinToken()).toBeNull();
    expect(window.sessionStorage.getItem("ym.join")).toBeNull();
  });
});
