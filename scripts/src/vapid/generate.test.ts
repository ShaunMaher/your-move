import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutFileError } from "../secrets/out-file.js";
import { newVapidKeys, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE, writeVapidKeys } from "./generate.js";

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "gen-vapid-")));
  root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("gen:vapid (09 §1)", () => {
  it("makes a P-256 pair in the shapes the config takes, the halves matching", async () => {
    const { publicKey, privateKey } = await newVapidKeys();
    expect(publicKey).toMatch(/^[\w-]{87}$/u);
    expect(privateKey).toMatch(/^[\w-]{43}$/u);
    const point = Buffer.from(publicKey, "base64url");
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
    const jwk = {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    };
    const algorithm = { name: "ECDSA", namedCurve: "P-256" };
    const signer = await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: privateKey },
      algorithm,
      false,
      ["sign"],
    );
    const verifier = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
    const data = new TextEncoder().encode("check");
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, data);
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, data),
    ).toBe(true);
  });

  it("writes both keys to new 0600 files and returns only the public key", async () => {
    const dir = join(base, "secrets");
    mkdirSync(dir);
    const written = await writeVapidKeys(dir, root);
    const publicText = readFileSync(join(dir, PUBLIC_KEY_FILE), "utf8");
    const privateText = readFileSync(join(dir, PRIVATE_KEY_FILE), "utf8");
    expect(publicText).toBe(`${written.publicKey}\n`);
    expect(privateText).toMatch(/^[\w-]{43}\n$/u);
    expect(JSON.stringify(written)).not.toContain(privateText.trim());
    for (const file of [PUBLIC_KEY_FILE, PRIVATE_KEY_FILE]) {
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites an existing key, and writes nothing beside one", async () => {
    const dir = join(base, "secrets");
    mkdirSync(dir);
    writeFileSync(join(dir, PRIVATE_KEY_FILE), "in use\n");
    await expect(writeVapidKeys(dir, root)).rejects.toThrow(/already exists/u);
    expect(readFileSync(join(dir, PRIVATE_KEY_FILE), "utf8")).toBe("in use\n");
    expect(existsSync(join(dir, PUBLIC_KEY_FILE))).toBe(false);
  });

  it("writes no private key when only the public key exists (A8-S-4)", async () => {
    const dir = join(base, "secrets");
    mkdirSync(dir);
    writeFileSync(join(dir, PUBLIC_KEY_FILE), "in use\n");
    await expect(writeVapidKeys(dir, root)).rejects.toThrow(/already exists/u);
    expect(readFileSync(join(dir, PUBLIC_KEY_FILE), "utf8")).toBe("in use\n");
    expect(existsSync(join(dir, PRIVATE_KEY_FILE))).toBe(false);
  });

  it("removes the private key when writing the public key fails", async () => {
    const dir = join(base, "secrets");
    mkdirSync(dir);
    let writes = 0;
    const failSecond: typeof writeFile = (file, data, options) => {
      writes += 1;
      return writes === 2 ? Promise.reject(new Error("disk full")) : writeFile(file, data, options);
    };
    await expect(writeVapidKeys(dir, root, failSecond)).rejects.toThrow("disk full");
    expect(existsSync(join(dir, PRIVATE_KEY_FILE))).toBe(false);
    expect(existsSync(join(dir, PUBLIC_KEY_FILE))).toBe(false);
  });

  it("refuses a directory inside the repository", async () => {
    await expect(writeVapidKeys(root, root)).rejects.toThrow(OutFileError);
  });
});
