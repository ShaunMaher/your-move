/**
 * Whether this process can compile code from strings (`eval`, `new Function`). The server runs
 * with `--disallow-code-generation-from-strings`, and checks it really is off before it loads any
 * game code (02 §7.5): a start without the flag is refused, not silently weaker.
 */
export function codeGenerationFromStringsAllowed(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the probe itself: succeeds only if code generation is allowed
    new Function("");
    return true;
  } catch {
    return false;
  }
}
