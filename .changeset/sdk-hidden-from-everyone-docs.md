---
"@your-move/sdk": patch
---

The TSDoc of `GameTestHooks.hiddenFromEveryone` now states what the flag means (02 §6.3): while the
game is in progress, every seat and the public get the same view, and every seat not to act the
same summary as the public, which is what the kit checks at every step; what the seats to act get
rests on `perturbHidden` covering everything hidden, which the module's own tests must show. No type
changes.
