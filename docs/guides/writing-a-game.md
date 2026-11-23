# Writing a game for Your Move

> **Stub.** This guide is written in milestone M1 alongside the reference game
> (`@your-move/game-example`) and revised in M5. The contract it explains is specified in
> [`docs/spec/02-game-framework.md`](../spec/02-game-framework.md); engineering rules are in
> [`docs/spec/11-engineering.md`](../spec/11-engineering.md).

## Planned sections

1. **What a game package is** — the `/engine`, `/client` and `/manifest` entry points, and why
   installing a game means trusting its code (02 §7.1, §7.5).
2. **Setting up a game repository** — starting from the example game, the `.npmrc` line for the
   package registry, `@your-move/sdk` and `@your-move/testkit`.
3. **Writing the engine** — options and `resolveOptions`, `setup`, `toAct` and turn phases,
   `validate` and `apply`, per-seat views and keeping secrets, randomness through `RandomSource`.
4. **Testing** — the generic test kit (schema, replay, secrecy, termination, turn sanity, CPU
   budget) and the architecture rules; writing your own rules tables.
5. **Writing the client** — `Board`, `OptionsForm`, `RulesSheet`, `HistoryItem`, local previews,
   accessibility.
6. **Versions** — rules versions, package semver and SDK compatibility ranges.
7. **Publishing and installing** — publishing your package, and how an operator adds it to
   `instance.config.ts` and runs `pnpm games:verify`.
8. **Checklist before you publish.**
