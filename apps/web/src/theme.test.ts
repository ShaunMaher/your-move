import { afterEach, describe, expect, it, vi } from "vitest";

import { applyStoredTheme, applyTheme, storedTheme } from "./theme.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("the theme", () => {
  it("sets data-theme for light and dark, removes it for system, and remembers the choice", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storedTheme()).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(storedTheme()).toBe("system");
  });

  it("shows the remembered theme at start-up, and ignores anything else in storage", () => {
    window.localStorage.setItem("ym.theme", "dark");
    applyStoredTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    window.localStorage.setItem("ym.theme", "purple");
    applyStoredTheme();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("copes with storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedTheme()).toBe("system");
    expect(() => {
      applyTheme("dark");
    }).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
