---
"@your-move/testkit": minor
---

The kit now checks what `test.hiddenFromEveryone` claims (02 §6.3): for a module that sets it, at
every step while the game is in progress, every seat and the public must get the same view
(identical JSON, key order included), and every seat not in `toAct` the same summary as the public.
The kit fails the module, under the secrecy property, on the first step where either doesn't hold.
Only the seats to act may get their own summary ("your turn"). The kit reads the flag once per rules
version, before playing it.

**Migration.** This is a stricter check, so a module that set the flag loosely now fails. If your
module sets `hiddenFromEveryone: true`, make its `view` the same for every viewer while the game is
in progress, and its `summary` the same as the public's for every seat that isn't to act: take
per-viewer conveniences (which seat is yours) from the envelope, which already says who the viewer
is and who is to act. If some viewer does see information another doesn't (a hand, say), the flag
is wrong: remove it, and make `perturbHidden` change what other viewers see instead.
