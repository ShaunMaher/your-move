/**
 * The game parts of `users.settings` (04): the remembered options per game type and the last game
 * type (05 §Remembered options). The column is JSON; anything unreadable counts as unset, and
 * every other key is kept as it is when these are written.
 */
const MAX_REMEMBERED_BYTES = 4096;

function read(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Unreadable settings count as unset.
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The remembered option input for a game type, if any. */
export function lastOptionsOf(settings: string, gameType: string): unknown {
  const last = read(settings)["lastOptions"];
  return isRecord(last) ? last[gameType] : undefined;
}

/**
 * The create path's option input (05 §Remembered options): omitted top-level keys are filled from
 * the remembered input, request keys winning. Only objects merge; anything else is used as given.
 */
export function mergeOptions(input: unknown, remembered: unknown): unknown {
  if (!isRecord(remembered)) return input;
  if (input === undefined) return remembered;
  if (!isRecord(input)) return input;
  return { ...remembered, ...input };
}

/**
 * The settings with `input` remembered for `gameType`, and `gameType` as the last one. An input
 * too large to be worth keeping is not remembered (the options came from a 16 kB body).
 */
export function rememberOptions(settings: string, gameType: string, input: unknown): string {
  const current = read(settings);
  const last = isRecord(current["lastOptions"]) ? current["lastOptions"] : {};
  const serialised = JSON.stringify(input ?? {});
  const lastOptions =
    serialised.length > MAX_REMEMBERED_BYTES ? last : { ...last, [gameType]: input ?? {} };
  return JSON.stringify({ ...current, lastOptions, lastGameType: gameType });
}
