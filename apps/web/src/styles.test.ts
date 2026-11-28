// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** The custom properties declared in the first block that follows `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const found: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
    if (name !== undefined && value !== undefined) found[name] = value;
  }
  return found;
}

describe("the dark theme's tokens (07 §5, A9-P-3)", () => {
  it("are the same under the device setting and under the manual choice", () => {
    const device = tokens(':root:not([data-theme="light"])');
    const manual = tokens(':root[data-theme="dark"]');
    expect(Object.keys(device).length).toBeGreaterThan(5);
    expect(manual).toEqual(device);
  });

  it("override every colour the light theme declares", () => {
    const light = Object.keys(tokens(":root {")).filter((name) => name.startsWith("--color-"));
    expect(Object.keys(tokens(':root[data-theme="dark"]')).sort()).toEqual(light.sort());
  });
});
