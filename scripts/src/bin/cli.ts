/** Shared helpers for the repository's command-line scripts. */
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";

/** The repository root. */
export const ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));

/** Prints problems and exits non-zero. */
export function fail(command: string, problems: readonly string[]): never {
  console.error(`${command}: failed\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}

/** Runs an async main, reporting errors as a failure of `command`. */
export function run(command: string, main: () => Promise<void>): void {
  Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      fail(command, [error instanceof Error ? error.message : String(error)]);
    });
}

/** Formats generated text with the repository's Prettier config, so it passes `format:check`. */
export async function formatAs(file: string, text: string): Promise<string> {
  const options = await resolveConfig(file);
  return format(text, { ...options, filepath: file });
}
