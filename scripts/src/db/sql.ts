/**
 * Just enough of SQLite's lexer to check migration text (04 §Migrations, M2a review S2-1, P2-1):
 * the comments are taken out, whitespace outside them is collapsed to single spaces, and the text
 * is split into statements at `;` — but not inside string literals, quoted identifiers or a
 * `CREATE TRIGGER` body, which ends at `END;` the way `sqlite3_complete()` decides it.
 *
 * Literals stay in the statements, so a pattern can match inside one: the checks that use this
 * err towards flagging, never towards missing.
 */

export interface LexedSql {
  /** Statements without comments, whitespace collapsed, empty ones dropped. */
  readonly statements: readonly string[];
  /** Every comment, verbatim (`-- …` without its newline, `/* … *\/` with its delimiters). */
  readonly comments: readonly string[];
}

const QUOTE_CLOSERS: Readonly<Record<string, string>> = { "'": "'", '"': '"', "`": "`", "[": "]" };

const normalise = (text: string): string => text.replace(/\s+/gu, " ").trim();

const TRIGGER = /^CREATE (?:TEMP |TEMPORARY )?TRIGGER\b/iu;

/** The index just past the quoted run starting at `start` (to the end if it never closes). */
function skipQuoted(sql: string, start: number): number {
  const open = sql.charAt(start);
  const close = QUOTE_CLOSERS[open] ?? open;
  let at = start + 1;
  while (at < sql.length) {
    if (sql.charAt(at) === close) {
      // A doubled quote is an escaped one, except in [identifiers].
      if (close !== "]" && sql.charAt(at + 1) === close) {
        at += 2;
        continue;
      }
      return at + 1;
    }
    at += 1;
  }
  return sql.length;
}

/** Splits `sql` into normalised statements and its comments. */
export function lexSql(sql: string): LexedSql {
  const statements: string[] = [];
  const comments: string[] = [];
  let current = "";
  // Where the text after the statement's last `;` starts (inside a trigger body).
  let segmentStart = 0;
  let at = 0;

  const endStatement = (): void => {
    const statement = normalise(current);
    if (statement !== "") statements.push(statement);
    current = "";
    segmentStart = 0;
  };

  while (at < sql.length) {
    const char = sql.charAt(at);
    const pair = sql.slice(at, at + 2);
    if (char in QUOTE_CLOSERS) {
      const end = skipQuoted(sql, at);
      current += sql.slice(at, end);
      at = end;
    } else if (pair === "--") {
      const newline = sql.indexOf("\n", at);
      const end = newline === -1 ? sql.length : newline;
      comments.push(sql.slice(at, end));
      current += " ";
      at = end;
    } else if (pair === "/*") {
      const close = sql.indexOf("*/", at + 2);
      const end = close === -1 ? sql.length : close + 2;
      comments.push(sql.slice(at, end));
      current += " ";
      at = end;
    } else if (char === ";") {
      at += 1;
      const inTrigger = TRIGGER.test(normalise(current));
      if (!inTrigger || /^END$/iu.test(normalise(current.slice(segmentStart)))) {
        endStatement();
      } else {
        current += ";";
        segmentStart = current.length;
      }
    } else {
      current += char;
      at += 1;
    }
  }
  endStatement();
  return { statements, comments };
}
