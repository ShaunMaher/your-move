/**
 * The licence allow-list (docs/spec/11-engineering.md §6): every production dependency and every
 * installed game package must be under one of these, or have an owner decision recorded in
 * docs/licences.md (dependencies) or an `acceptLicence` in instance.config.ts (games).
 */
export const ALLOWED_LICENCES: ReadonlySet<string> = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

type Token = "(" | ")" | "AND" | "OR" | "WITH" | { id: string };

function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  for (const raw of expression.replace(/[()]/gu, " $& ").trim().split(/\s+/u)) {
    if (raw === "") return null;
    const upper = raw.toUpperCase();
    if (raw === "(" || raw === ")") tokens.push(raw);
    else if (upper === "AND" || upper === "OR" || upper === "WITH") tokens.push(upper);
    else if (/^[A-Za-z0-9.+-]+$/u.test(raw)) tokens.push({ id: raw });
    else return null;
  }
  return tokens;
}

/**
 * Whether an SPDX licence expression is acceptable under `allowed`: `OR` needs one acceptable
 * side, `AND` needs both, a licence `WITH` an exception is acceptable only if the whole
 * `id WITH exception` string is allowed. `id+` ("or later") is judged as `id`. A malformed or
 * empty expression is never acceptable.
 */
export function isAllowedExpression(
  expression: string,
  allowed: ReadonlySet<string> = ALLOWED_LICENCES,
): boolean {
  const tokens = tokenize(expression);
  if (!tokens || tokens.length === 0) return false;
  let position = 0;
  const peek = (): Token | undefined => tokens[position];

  function atom(): boolean | null {
    const token = tokens?.[position++];
    if (token === "(") {
      const value = or();
      return tokens?.[position++] === ")" ? value : null;
    }
    if (token === undefined || typeof token === "string") return null;
    const id = token.id.replace(/\+$/u, "");
    if (peek() === "WITH") {
      position++;
      const exception = tokens?.[position++];
      if (exception === undefined || typeof exception === "string") return null;
      return allowed.has(`${id} WITH ${exception.id}`);
    }
    return allowed.has(id);
  }

  function and(): boolean | null {
    let value = atom();
    while (value !== null && peek() === "AND") {
      position++;
      const right = atom();
      value = right === null ? null : value && right;
    }
    return value;
  }

  function or(): boolean | null {
    let value = and();
    while (value !== null && peek() === "OR") {
      position++;
      const right = and();
      value = right === null ? null : value || right;
    }
    return value;
  }

  const result = or();
  return result === true && position === tokens.length;
}
