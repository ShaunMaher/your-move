/**
 * `pnpm gen:vapid --out <dir>` (docs/spec/09-operations.md §1): writes a new VAPID key pair for
 * Web Push to `<dir>/vapid_public_key` and `<dir>/vapid_private_key` (new 0600 files, outside the
 * repository). Prints the public key and where the files went, never the private key.
 */
import { parseArgs } from "node:util";

import { writeVapidKeys } from "../vapid/generate.js";
import { ROOT_DIR, run } from "./cli.js";

run("gen:vapid", async () => {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (values.out === undefined) {
    throw new Error("--out <dir> is required: the directory the key files go to");
  }
  const written = await writeVapidKeys(values.out, ROOT_DIR);
  console.log(`VAPID public key: ${written.publicKey}`);
  console.log(`Wrote ${written.publicKeyFile} and ${written.privateKeyFile} (mode 0600).`);
  console.log(
    "Give them to the server as VAPID_PUBLIC_KEY_FILE and VAPID_PRIVATE_KEY_FILE (Docker secrets), and set VAPID_SUBJECT.",
  );
  console.log(
    "Keep the pair: a new one makes every device's subscription stop working until it subscribes again.",
  );
});
