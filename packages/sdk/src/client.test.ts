import { isValidElement } from "react";
import { describe, expect, it } from "vitest";

import { TextView, formatText } from "./client.js";
import { z } from "./schema.js";

describe("formatText", () => {
  it("fills seats with names, and numbers unnamed seats from 1", () => {
    expect(formatText([{ seat: 0 }, " beat ", { seat: 2 }], ["Ann", "Bo"])).toBe("Ann beat Seat 3");
  });
});

describe("TextView", () => {
  it("renders the formatted text", () => {
    const element = TextView({ text: [{ seat: 1 }, " passed"], names: ["Ann", "Bo"] });
    expect(isValidElement(element)).toBe(true);
    expect((element.props as { children: unknown }).children).toBe("Bo passed");
  });
});

describe("/schema", () => {
  it("re-exports Zod", () => {
    expect(z.string().safeParse("x").success).toBe(true);
  });
});
