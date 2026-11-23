---
"@your-move/sdk": minor
---

First release of the game SDK (0.x: any minor may break until the MVP, 02 §7.4): the
`GameDefinition`, `GameManifest` and `GameClientModule` contracts, the recording and replaying
`RandomSource` with `shuffle`, `Resources`, the reserved error codes, and the client-facing API
types as Zod schemas (`GameEnvelope`, `SubmitResult`, `Text`). `@your-move/sdk/schema` re-exports
Zod; `@your-move/sdk/client` holds the client contract and the React helpers (`formatText`,
`TextView`).
