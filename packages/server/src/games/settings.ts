/**
 * The game parts of `users.settings` (04): the remembered options per game type and the last game
 * type (05 §Remembered options), and `whoCanAddMe` (06 §6.2). The column is JSON; anything unreadable counts as unset. Writes
 * go through `UserRepo.rememberGameOptions`, which changes only these keys in SQL.
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

/**
 * Who may add the user to games (06 §6.2, 04 `users.settings.whoCanAddMe`): `nobody` only when the
 * stored value says exactly that, otherwise the default, `pastOpponents`. Nothing in the app sets
 * it before M4's Settings choice; a stored value is honoured already (A12-P-3).
 */
export function whoCanAddMeOf(settings: string): "pastOpponents" | "nobody" {
  return read(settings)["whoCanAddMe"] === "nobody" ? "nobody" : "pastOpponents";
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
 * The option input as stored in `lastOptions[gameType]`, or null when it is too large to be worth
 * keeping (the options came from a 16 kB body): then only `lastGameType` changes.
 */
export function rememberedInput(input: unknown): string | null {
  const serialised = JSON.stringify(input ?? {});
  return serialised.length > MAX_REMEMBERED_BYTES ? null : serialised;
}
