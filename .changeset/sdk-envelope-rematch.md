---
"@your-move/sdk": minor
---

`gameEnvelopeSchema` gains the optional `rematch` field (05 `POST /api/v1/games/:id/rematch`,
alpha A15): on a finished game, `null` or `{ gameId, you: "joined" | "invited" | "none" }`, the
game's rematch and the viewer's place in it. Absent for every other status.

`RESERVED_ERROR_CODES` gains `REMATCH_UNAVAILABLE`, the framework's answer when too few players of a
finished game remain for its rematch; `GameDefinition.resolveOptions` documents 02 §2.1 rule 10
(resolved options are a valid input; version keys accepted, ignored, never honoured).
