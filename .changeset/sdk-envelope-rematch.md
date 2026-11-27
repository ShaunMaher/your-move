---
"@your-move/sdk": minor
---

`gameEnvelopeSchema` gains the optional `rematch` field (05 `POST /api/v1/games/:id/rematch`,
alpha A15): on a finished game, `null` or `{ gameId, you: "joined" | "invited" | "none" }`, the
game's rematch and the viewer's place in it. Absent for every other status.
