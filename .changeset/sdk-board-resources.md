---
"@your-move/sdk": patch
---

`BoardProps` has a new optional `resources` prop (`BoardResources`): the game's public resources,
once the shell has loaded them. Its `dictionary` entry is a `PublicWordList` (`id`, `version`,
`has(word)`, `follows(prefix)`), handed over only for a list marked `distribution: "public"`. A
board that ignores the prop works as before, so the change is backward compatible.
