import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ROOT_DIR } from "../bin/cli.js";
import { ICONS, renderIcon } from "./icons.js";

describe("web icons", () => {
  it.each(Object.entries(ICONS))("%s is a PNG of the declared size", (_name, { size, style }) => {
    const png = renderIcon(size, style);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it("is deterministic", () => {
    const { size, style } = ICONS["icon-192.png"] ?? {
      size: 0,
      style: { rounded: true, glyphScale: 1 },
    };
    expect(renderIcon(size, style).equals(renderIcon(size, style))).toBe(true);
  });

  it.each(Object.entries(ICONS))(
    "the committed %s matches the generator",
    (name, { size, style }) => {
      const committed = readFileSync(join(ROOT_DIR, "apps/web/public/icons", name));
      expect(committed.equals(renderIcon(size, style))).toBe(true);
    },
  );
});
