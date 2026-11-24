import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  resetBundleInputs,
  uncheckedInputs,
  writeBundleInputs,
  writeVerifiedFiles,
  type CheckedPackage,
} from "./inputs.js";

const ENGINE = "dist/engine/index.js";
const RULES = "dist/engine/rules.js";
const CLIENT = "dist/client/index.js";
const MANIFEST = "dist/manifest.js";

/**
 * A repository root with one installed game package, `@x/game-x` in games/x, holding `files`, and
 * an installed.json listing it. Returns the root and what games:verify checked in the package: the
 * engine entry and its rules module, the manifest, and the client entry.
 */
function instance(extraFiles: readonly string[] = []): { root: string; pkg: CheckedPackage } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inputs-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, "games/x");
  for (const file of [ENGINE, RULES, CLIENT, MANIFEST, ...extraFiles]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(
    join(root, "generated/installed.json"),
    JSON.stringify({ x: { package: "@x/game-x", version: "1.0.0", rulesVersions: [1] } }),
  );
  const at = (file: string) => join(dir, file);
  const pkg: CheckedPackage = {
    name: "@x/game-x",
    dir,
    entries: { engine: at(ENGINE), client: at(CLIENT), manifest: at(MANIFEST) },
    engine: [at(ENGINE), at(RULES), at(MANIFEST)],
    client: [at(CLIENT)],
  };
  return { root, pkg };
}

/** Records for every build that read exactly what each role may: a passing set. */
function recordGoodBuilds(root: string): void {
  const engineFiles = [ENGINE, RULES, MANIFEST].map((file) => `games/x/${file}`);
  writeBundleInputs(root, "web", root, [`games/x/${CLIENT}`, "apps/web/src/main.tsx"]);
  writeBundleInputs(
    root,
    "node",
    join(root, "apps/node"),
    engineFiles.map((f) => `../../${f}`),
  );
  writeBundleInputs(root, "worker", root, engineFiles);
}

describe("bundler-input closure", () => {
  it("records what games:verify checked, by role, relative to the root", () => {
    const { root, pkg } = instance();
    writeVerifiedFiles(root, [pkg]);
    expect(JSON.parse(readFileSync(join(root, "generated/verified-files.json"), "utf8"))).toEqual({
      packages: [
        {
          name: "@x/game-x",
          dir: "games/x",
          entries: {
            engine: `games/x/${ENGINE}`,
            client: `games/x/${CLIENT}`,
            manifest: `games/x/${MANIFEST}`,
          },
          engine: [`games/x/${ENGINE}`, `games/x/${RULES}`, `games/x/${MANIFEST}`].sort(),
          client: [`games/x/${CLIENT}`],
        },
      ],
    });
  });

  it("passes when every build read only files checked for its role, and its entries", () => {
    const { root, pkg } = instance();
    writeVerifiedFiles(root, [pkg]);
    recordGoodBuilds(root);
    expect(uncheckedInputs(root)).toEqual([]);
    // The web build may also read engine files: the client imports its own engine (02 §3).
    writeBundleInputs(root, "web", root, [`games/x/${CLIENT}`, `games/x/${RULES}`]);
    expect(uncheckedInputs(root, ["web"], true)).toEqual([]);
  });

  it("writes a build's inputs without virtual modules or query strings", () => {
    const { root } = instance();
    writeBundleInputs(root, "web", root, [
      join(root, `games/x/${CLIENT}`),
      "\0virtual",
      "apps/web/src/main.tsx?x=1",
      "apps/web/src/main.tsx",
    ]);
    expect(JSON.parse(readFileSync(join(root, "generated/bundles/web.json"), "utf8"))).toEqual({
      baseDir: root,
      inputs: [join(root, `games/x/${CLIENT}`), "apps/web/src/main.tsx"].sort(),
    });
  });

  it("fails on an input from a game package that wasn't checked", () => {
    const { root, pkg } = instance(["dist/engine/package.json", "dist/other.js"]);
    writeVerifiedFiles(root, [pkg]);
    recordGoodBuilds(root);
    writeBundleInputs(root, "web", root, [`games/x/${CLIENT}`, "games/x/dist/other.js"]);
    writeBundleInputs(root, "node", root, [
      `games/x/${ENGINE}`,
      `games/x/${MANIFEST}`,
      "games/x/dist/engine/package.json",
    ]);
    expect(uncheckedInputs(root, ["web", "node"])).toEqual([
      "the web build read games/x/dist/other.js from @x/game-x, which games:verify didn't check",
      "the node build read games/x/dist/engine/package.json from @x/game-x, which games:verify didn't check",
    ]);
  });

  it("fails a server build that read a file checked only as client code", () => {
    // The engine imports `./rules` and a bundler picks `rules.jsx`, which the client reaches too:
    // checked, but only as client code, so the engine rules never ran on it.
    const { root, pkg } = instance(["dist/engine/rules.jsx"]);
    writeVerifiedFiles(root, [
      { ...pkg, client: [...pkg.client, join(pkg.dir, "dist/engine/rules.jsx")] },
    ]);
    recordGoodBuilds(root);
    writeBundleInputs(root, "worker", root, [
      `games/x/${ENGINE}`,
      `games/x/${MANIFEST}`,
      "games/x/dist/engine/rules.jsx",
    ]);
    expect(uncheckedInputs(root, ["worker"])).toEqual([
      "the worker build read games/x/dist/engine/rules.jsx from @x/game-x, which games:verify checked only as client code",
    ]);
    // The web build may read it.
    writeBundleInputs(root, "web", root, [`games/x/${CLIENT}`, "games/x/dist/engine/rules.jsx"]);
    expect(uncheckedInputs(root, ["web"])).toEqual([]);
  });

  it("follows symlinks before comparing", () => {
    const { root, pkg } = instance();
    writeVerifiedFiles(root, [pkg]);
    recordGoodBuilds(root);
    mkdirSync(join(root, "node_modules/@x"), { recursive: true });
    symlinkSync(join(root, "games/x"), join(root, "node_modules/@x/game-x"));
    writeBundleInputs(root, "node", root, [
      `node_modules/@x/game-x/${ENGINE}`,
      `node_modules/@x/game-x/${MANIFEST}`,
    ]);
    expect(uncheckedInputs(root, ["node"])).toEqual([]);
  });

  it("fails a record that lacks the entry points its build must read", () => {
    const { root, pkg } = instance();
    writeVerifiedFiles(root, [pkg]);
    recordGoodBuilds(root);
    writeBundleInputs(root, "node", root, []);
    writeBundleInputs(root, "web", root, []);
    expect(uncheckedInputs(root, ["node"])).toEqual([
      `the node build didn't read games/x/${ENGINE}, the engine entry point of @x/game-x: its record is incomplete`,
      `the node build didn't read games/x/${MANIFEST}, the manifest entry point of @x/game-x: its record is incomplete`,
    ]);
    // The web record needs the client entries only once the web app imports them (M3).
    expect(uncheckedInputs(root, ["web"], false)).toEqual([]);
    expect(uncheckedInputs(root, ["web"], true)).toEqual([
      `the web build didn't read games/x/${CLIENT}, the client entry point of @x/game-x: its record is incomplete`,
    ]);
  });

  it("fails when an installed package wasn't verified", () => {
    const { root } = instance();
    writeVerifiedFiles(root, []);
    recordGoodBuilds(root);
    expect(uncheckedInputs(root)).toEqual([
      "@x/game-x is installed (generated/installed.json) but not in generated/verified-files.json: run pnpm games:verify",
    ]);
    rmSync(join(root, "generated/installed.json"));
    expect(uncheckedInputs(root)).toEqual([
      "generated/installed.json is missing: run pnpm games:generate",
    ]);
  });

  it("fails closed when a record is missing, and reset deletes every build's record", () => {
    const { root, pkg } = instance();
    expect(uncheckedInputs(root)).toEqual([
      "generated/verified-files.json is missing: run pnpm games:verify first",
    ]);
    writeVerifiedFiles(root, [pkg]);
    recordGoodBuilds(root);
    resetBundleInputs(root);
    expect(existsSync(join(root, "generated/bundles"))).toBe(false);
    writeBundleInputs(root, "web", root, []);
    expect(uncheckedInputs(root)).toEqual([
      "generated/bundles/node.json is missing: the node build didn't record its inputs",
      "generated/bundles/worker.json is missing: the worker build didn't record its inputs",
    ]);
  });
});
