---
"@your-move/testkit": minor
---

The kit checks the new contract rule 02 §2.1 rule 10: the options `resolveOptions` returns for each
option input must resolve again to themselves, unchanged, under the same context (a rematch resolves
a finished game's stored options). A module whose resolved options carry keys its input refuses
(versions, say) now fails the schema property until it accepts and ignores them.

The check gives the module a `structuredClone` of the options and compares its result with a
snapshot taken before the call, so a module that changes its input fails rather than passes.
