/** `pnpm lint:pins`: Node and pnpm are pinned to the same versions everywhere (../pins/check.ts). */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkPins, type PinnedFiles } from "../pins/check.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("lint:pins", () => {
  const read = (file: keyof PinnedFiles): string => readFileSync(join(ROOT_DIR, file), "utf8");
  const problems = checkPins({
    "mise.toml": read("mise.toml"),
    "package.json": read("package.json"),
    "apps/node/Dockerfile": read("apps/node/Dockerfile"),
    ".gitlab-ci.yml": read(".gitlab-ci.yml"),
  });
  if (problems.length > 0) fail("lint:pins", problems);
  console.log("lint:pins: Node and pnpm pins agree");
  return Promise.resolve();
});
