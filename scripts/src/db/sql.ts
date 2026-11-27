/**
 * Just enough of SQLite's lexer to check migration text (04 §Migrations, M2a review S2-1, P2-1):
 * the comments are taken out, whitespace outside them is collapsed to single spaces, and the text
 * is split into statements at `;` — but not inside string literals, quoted identifiers or a
 * `CREATE TRIGGER` body, which ends at `END;` the way `sqlite3_complete()` decides it.
 *
 * Literals stay in the statements, so a pattern can match inside one: the checks that use this
 * err towards flagging, never towards missing.
 *
 * {@link tokenizeSql} reads stored table SQL for the schema comparison (issue #13 S-1).
 */

/** drizzle-kit's separator between the statements of one migration file. */
export const BREAKPOINT = "--> statement-breakpoint";

export interface LexedSql {
  /** Statements without comments, whitespace collapsed, empty ones dropped. */
  readonly statements: readonly string[];
  /**
   * Every comment, verbatim: `-- …` without its line ending (`\n` or `\r\n`), `/* … *\/` with its
   * delimiters.
   */
  readonly comments: readonly string[];
  /** Whether a block comment, string literal or quoted identifier runs to the end unclosed. */
  readonly unterminated: boolean;
}

const QUOTE_CLOSERS: Readonly<Record<string, string>> = { "'": "'", '"': '"', "`": "`", "[": "]" };

const normalise = (text: string): string => text.replace(/\s+/gu, " ").trim();

const TRIGGER = /^CREATE (?:TEMP |TEMPORARY )?TRIGGER\b/iu;

/**
 * The index just past the quoted run starting at `start`, or the end of `sql` with `closed` false
 * when it never closes.
 */
function skipQuoted(sql: string, start: number): { end: number; closed: boolean } {
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
      return { end: at + 1, closed: true };
    }
    at += 1;
  }
  return { end: sql.length, closed: false };
}

/** Splits `sql` into normalised statements and its comments. */
export function lexSql(sql: string): LexedSql {
  const statements: string[] = [];
  const comments: string[] = [];
  let current = "";
  // Where the text after the statement's last `;` starts (inside a trigger body).
  let segmentStart = 0;
  let unterminated = false;
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
      const { end, closed } = skipQuoted(sql, at);
      unterminated ||= !closed;
      current += sql.slice(at, end);
      at = end;
    } else if (pair === "--") {
      const newline = sql.indexOf("\n", at);
      const end = newline === -1 ? sql.length : newline;
      comments.push(sql.slice(at, end).replace(/\r$/u, ""));
      current += " ";
      at = end;
    } else if (pair === "/*") {
      const close = sql.indexOf("*/", at + 2);
      unterminated ||= close === -1;
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
  return { statements, comments, unterminated };
}

/**
 * A migration as each driver reads it (04 §Migrations): whole, as SQLite and wrangler read it on
 * D1, where {@link BREAKPOINT} is a comment; and cut at every {@link BREAKPOINT} first, as
 * Drizzle's migrator cuts it on Node, even inside a literal or a comment (issue #13 R-2).
 */
export function migrationReadings(sql: string): readonly LexedSql[] {
  const pieces = sql.split(BREAKPOINT).map(lexSql);
  return [
    lexSql(sql),
    {
      statements: pieces.flatMap((piece) => piece.statements),
      comments: pieces.flatMap((piece) => piece.comments),
      unterminated: pieces.some((piece) => piece.unterminated),
    },
  ];
}

export interface SqlToken {
  /** A bare word (keyword, identifier or number), a quoted identifier, a string, or punctuation. */
  readonly kind: "word" | "identifier" | "string" | "punctuation";
  /**
   * Words and identifiers lower-cased and unquoted (SQLite compares both without case), strings
   * verbatim with their quotes, punctuation one character each.
   */
  readonly text: string;
}

const WORD = /[\p{L}\p{N}_$]/u;

/** The tokens of `sql`, without whitespace or comments. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let at = 0;
  while (at < sql.length) {
    const char = sql.charAt(at);
    const pair = sql.slice(at, at + 2);
    if (/\s/u.test(char)) {
      at += 1;
    } else if (pair === "--") {
      const newline = sql.indexOf("\n", at);
      at = newline === -1 ? sql.length : newline + 1;
    } else if (pair === "/*") {
      const close = sql.indexOf("*/", at + 2);
      at = close === -1 ? sql.length : close + 2;
    } else if (char in QUOTE_CLOSERS) {
      const { end } = skipQuoted(sql, at);
      const quoted = sql.slice(at, end);
      if (char === "'") {
        tokens.push({ kind: "string", text: quoted });
      } else {
        const close = QUOTE_CLOSERS[char] ?? char;
        const inner =
          quoted.endsWith(close) && quoted.length > 1 ? quoted.slice(1, -1) : quoted.slice(1);
        const name = close === "]" ? inner : inner.replaceAll(close + close, close);
        tokens.push({ kind: "identifier", text: name.toLowerCase() });
      }
      at = end;
    } else if (WORD.test(char)) {
      let end = at + 1;
      while (end < sql.length && WORD.test(sql.charAt(end))) end += 1;
      tokens.push({ kind: "word", text: sql.slice(at, end).toLowerCase() });
      at = end;
    } else {
      tokens.push({ kind: "punctuation", text: char });
      at += 1;
    }
  }
  return tokens;
}
