/**
 * Structured JSON logging (docs/spec/09-operations.md §5). The runtime supplies the sink (stdout on
 * both targets); core code never writes to the console directly. Never log OTPs, tokens, cookies,
 * request bodies, email addresses or game secrets.
 */
import type { LogLevel } from "./config/parse.js";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/** A logger writing one JSON object per line to `sink`, dropping entries below `level`. */
export function createJsonLogger(options: {
  readonly level: LogLevel;
  readonly sink: (line: string) => void;
  readonly now: () => Date;
}): Logger {
  const write =
    (level: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      if (ORDER[level] < ORDER[options.level]) return;
      options.sink(JSON.stringify({ ...fields, time: options.now().toISOString(), level, msg }));
    };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}
