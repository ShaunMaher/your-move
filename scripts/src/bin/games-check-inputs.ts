/**
 * `pnpm games:check-inputs`: after the web, Node and Worker builds, fails when any bundler read a
 * file from an installed game package that `games:verify` didn't check (10 M1; ../games/inputs.ts).
 * `pnpm build` runs it last; the Docker build runs it with `--only web,node`.
 */
import { parseArgs } from "node:util";

import { BUNDLES, uncheckedInputs, type Bundle } from "../games/inputs.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("games:check-inputs", () => {
  // `--only web,node`: the Docker build makes no Worker bundle.
  const { values } = parseArgs({ options: { only: { type: "string" } } });
  const only = values.only?.split(",") ?? [...BUNDLES];
  const unknown = only.filter((name) => !(BUNDLES as readonly string[]).includes(name));
  if (unknown.length > 0) fail("games:check-inputs", [`unknown bundles: ${unknown.join(", ")}`]);
  const problems = uncheckedInputs(ROOT_DIR, only as Bundle[]);
  if (problems.length > 0) fail("games:check-inputs", problems);
  console.log("games:check-inputs: every bundler input from a game package was checked");
  return Promise.resolve();
});
