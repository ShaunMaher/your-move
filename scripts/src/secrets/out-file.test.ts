import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkOutFile, OutFileError } from "./out-file.js";

let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "out-file-")));
  root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("checkOutFile (A5-S-6)", () => {
  it("accepts a new file in a plain directory outside the repository", () => {
    mkdirSync(join(base, "secrets"));
    expect(checkOutFile(join(base, "secrets", "token"), root)).toBe(join(base, "secrets", "token"));
  });

  it("refuses a file inside the repository, however it is spelled", () => {
    mkdirSync(join(root, "sub"));
    for (const out of [
      join(root, "token"),
      join(root, "sub", "token"),
      join(root, "sub", "..", "token"),
    ]) {
      expect(() => checkOutFile(out, root)).toThrow(OutFileError);
    }
  });

  it("refuses a symlinked directory that leads into the repository", () => {
    symlinkSync(root, join(base, "link"));
    expect(() => checkOutFile(join(base, "link", "token"), root)).toThrow(
      /outside the repository/u,
    );
  });

  it("does not mistake a directory named like `..x` inside the repository for an outside one", () => {
    mkdirSync(join(root, "..secrets"));
    expect(() => checkOutFile(join(root, "..secrets", "token"), root)).toThrow(OutFileError);
  });

  it("refuses any directory under another Git working tree, and a missing directory", () => {
    const other = join(base, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    mkdirSync(join(other, "deep", "er"), { recursive: true });
    expect(() => checkOutFile(join(other, "deep", "er", "token"), root)).toThrow(
      /Git working tree/u,
    );
    expect(() => checkOutFile(join(base, "missing", "token"), root)).toThrow(/does not exist/u);
  });
});
