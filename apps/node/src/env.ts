/**
 * Docker secrets (docs/spec/09-operations.md §1): on Node every secret may be given as a file,
 * `<NAME>_FILE=/run/secrets/<name>`, which wins over `<NAME>`. Exactly one trailing newline is
 * trimmed; setting both is allowed only if they are equal. Errors never contain a value.
 */
import { SECRET_VARIABLES, type Env } from "@your-move/server";

export type ReadFile = (path: string) => string;

/** Thrown for unreadable or conflicting secret files; the message names variables only. */
export class SecretFileError extends Error {
  override readonly name = "SecretFileError";
}

/** Returns `env` with every `<SECRET>_FILE` resolved into `<SECRET>`. */
export function resolveSecretFiles(
  env: Env,
  readFile: ReadFile,
): Record<string, string | undefined> {
  const resolved: Record<string, string | undefined> = { ...env };
  const problems: string[] = [];
  for (const name of SECRET_VARIABLES) {
    const path = env[`${name}_FILE`];
    if (path === undefined || path === "") continue;
    let value: string;
    try {
      value = readFile(path).replace(/\r?\n$/u, "");
    } catch {
      problems.push(`${name}_FILE: cannot read the file it names`);
      continue;
    }
    const direct = env[name];
    if (direct !== undefined && direct !== "" && direct !== value) {
      problems.push(`${name}, ${name}_FILE: both are set and they differ`);
      continue;
    }
    resolved[name] = value;
  }
  if (problems.length > 0) {
    throw new SecretFileError(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return resolved;
}

/**
 * Removes every secret, and every `<SECRET>_FILE` path, from the process environment once the
 * configuration has been read, before any game package code loads (02 §7.5).
 */
export function scrubSecrets(env: Record<string, string | undefined>): void {
  for (const name of SECRET_VARIABLES) {
    Reflect.deleteProperty(env, name);
    Reflect.deleteProperty(env, `${name}_FILE`);
  }
}
