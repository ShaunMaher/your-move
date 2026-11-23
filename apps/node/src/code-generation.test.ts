import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { codeGenerationFromStringsAllowed } from "./code-generation.js";

/** Runs the probe in a fresh Node process with the given flags. */
function probe(flags: string[]): string {
  const module = fileURLToPath(new URL("./code-generation.ts", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      ...flags,
      "--input-type=module",
      "-e",
      `import { codeGenerationFromStringsAllowed } from ${JSON.stringify(module)};
       console.log(codeGenerationFromStringsAllowed() ? "allowed" : "disallowed");`,
    ],
    { encoding: "utf8" },
  );
  return result.stdout.trim();
}

describe("codeGenerationFromStringsAllowed", () => {
  it("reports allowed in an ordinary process", () => {
    expect(codeGenerationFromStringsAllowed()).toBe(true);
    expect(probe([])).toBe("allowed");
  });

  it("reports disallowed under --disallow-code-generation-from-strings", () => {
    expect(probe(["--disallow-code-generation-from-strings"])).toBe("disallowed");
  });
});
