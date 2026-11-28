---
"@your-move/testkit": minor
---

The kit now checks what `test.hiddenFromEveryone` claims (02 §6.3): for a module that sets it, every
seat and the public must get the same view (identical JSON, key order included) at every step
while the game is in progress, and the kit fails the module, under the secrecy property, on the
first step where two viewers' views differ. Summaries may still differ.

**Migration.** This is a stricter check, so a module that set the flag loosely now fails. If your
module sets `hiddenFromEveryone: true`, make its `view` the same for every viewer while the game is
in progress: move per-viewer conveniences ("your turn", which seat is yours) out of the view into
`summary` or take them from the envelope, which already says who the viewer is and who is to act.
If some viewer does see information another doesn't (a hand, say), the flag is wrong: remove it,
and make `perturbHidden` change what other viewers see instead.
