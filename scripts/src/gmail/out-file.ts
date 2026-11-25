/**
 * Where `pnpm gmail:authorize` may write the refresh token: a path outside the repository, so the
 * token can't be committed (09 §2). Symlinks are resolved on the parent directory, the comparison
 * is on path segments (a directory named `..foo` is not "outside"), and no directory above the
 * file may be a Git working tree.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export class OutFileError extends Error {
  override readonly name = "OutFileError";
}

/** The absolute path the token may go to, or throws {@link OutFileError}. */
export function checkOutFile(out: string, repositoryRoot: string): string {
  const requested = resolve(out);
  let parent: string;
  let root: string;
  try {
    parent = realpathSync(dirname(requested));
    root = realpathSync(repositoryRoot);
  } catch {
    throw new OutFileError("--out: the directory it names does not exist");
  }
  const file = join(parent, basename(requested));
  const fromRoot = relative(root, file);
  const outside = fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot);
  if (!outside) {
    throw new OutFileError("--out must be outside the repository, so the token can't be committed");
  }
  for (let directory = parent; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git"))) {
      throw new OutFileError(
        "--out must not be inside any Git working tree, so the token can't be committed",
      );
    }
    if (dirname(directory) === directory) break;
  }
  return file;
}
