/**
 * `pnpm gen:vapid --out <dir>` (docs/spec/09-operations.md §1): a new VAPID key pair for Web Push,
 * written to two new 0600 files in a directory outside the repository and any Git working tree:
 * `vapid_public_key` and `vapid_private_key`, ready to use as Docker secrets (`VAPID_*_FILE`).
 * Both are unpadded base64url: the 65-byte uncompressed P-256 point and the 32-byte private key.
 * The private key is never printed; the public key is (it is public, served by `/api/v1/config`).
 */
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkOutFile } from "../secrets/out-file.js";

export const PUBLIC_KEY_FILE = "vapid_public_key";
export const PRIVATE_KEY_FILE = "vapid_private_key";

/** Unpadded base64url. */
function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** A fresh P-256 key pair as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` take it. */
export async function newVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const point = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (d === undefined) throw new Error("the generated key has no private part");
  return { publicKey: base64Url(point), privateKey: d };
}

/**
 * Writes a new pair into `dir` and returns what may be shown: the public key and both paths.
 * Refuses a directory inside the repository or a Git working tree, and never overwrites a file:
 * if either file exists nothing is written, and if the second write fails the first file is
 * removed, so a half-written pair is never left behind (A8-S-4).
 */
export async function writeVapidKeys(
  dir: string,
  repositoryRoot: string,
  /** Tests only: a writer that fails. */
  write: typeof writeFile = writeFile,
): Promise<{ publicKey: string; publicKeyFile: string; privateKeyFile: string }> {
  const publicKeyFile = checkOutFile(join(dir, PUBLIC_KEY_FILE), repositoryRoot);
  const privateKeyFile = checkOutFile(join(dir, PRIVATE_KEY_FILE), repositoryRoot);
  const existing = [publicKeyFile, privateKeyFile].filter((file) => existsSync(file));
  if (existing.length > 0) {
    const verb = existing.length === 1 ? "exists" : "exist";
    throw new Error(
      `${existing.join(" and ")} already ${verb}: ` +
        "a key pair there may be in use, so nothing was written",
    );
  }
  const keys = await newVapidKeys();
  // `wx` as well: a file appearing in between is still never replaced.
  await write(privateKeyFile, `${keys.privateKey}\n`, { flag: "wx", mode: 0o600 });
  try {
    await write(publicKeyFile, `${keys.publicKey}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(privateKeyFile, { force: true });
    throw error;
  }
  return { publicKey: keys.publicKey, publicKeyFile, privateKeyFile };
}
