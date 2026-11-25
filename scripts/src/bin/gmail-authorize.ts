/**
 * `pnpm gmail:authorize --out <file>` (docs/spec/09-operations.md §2): obtains the Gmail refresh
 * token for the sender user. The client id and secret come from the environment or, preferably,
 * files (`GMAIL_CLIENT_ID_FILE`, `GMAIL_CLIENT_SECRET_FILE`), never from the command line;
 * `GMAIL_SENDER` is the sender's address. The token goes to a new 0600 file, never to the
 * terminal. The file must be outside the repository.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { authorize } from "../gmail/authorize.js";
import { ROOT_DIR, run } from "./cli.js";

/** A value from `NAME_FILE` (one trailing newline trimmed) or else `NAME`. */
function secret(name: string): string {
  const path = process.env[`${name}_FILE`];
  if (path !== undefined && path !== "") {
    try {
      return readFileSync(path, "utf8").replace(/\r?\n$/u, "");
    } catch {
      throw new Error(`${name}_FILE: cannot read the file it names`);
    }
  }
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} or ${name}_FILE is required`);
  return value;
}

run("gmail:authorize", async () => {
  const { values } = parseArgs({ options: { out: { type: "string" } } });
  if (values.out === undefined) throw new Error("--out <file> is required: where the token goes");
  const outFile = resolve(values.out);
  const fromRoot = relative(ROOT_DIR, outFile);
  if (!fromRoot.startsWith("..") && !isAbsolute(fromRoot)) {
    throw new Error("--out must be outside the repository, so the token can't be committed");
  }
  const sender = process.env["GMAIL_SENDER"];
  if (sender === undefined || sender === "") throw new Error("GMAIL_SENDER is required");
  await authorize({
    clientId: secret("GMAIL_CLIENT_ID"),
    clientSecret: secret("GMAIL_CLIENT_SECRET"),
    sender,
    outFile,
    fetch,
    print: (line) => {
      console.log(line);
    },
    now: () => new Date(),
    random: (bytes) => {
      crypto.getRandomValues(bytes);
    },
    timeoutMs: 10 * 60_000,
  });
});
