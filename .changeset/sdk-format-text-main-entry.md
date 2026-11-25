---
"@your-move/sdk": minor
---

`formatText` is now exported from the main entry too, so code that must not import React (the
server's email nudges, 03 §7) fills `Text` placeholders the same way clients do.
`@your-move/sdk/client` still exports it.
