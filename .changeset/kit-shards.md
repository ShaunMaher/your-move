---
"@your-move/testkit": minor
---

A full kit run can be split into shards (02 §6): `runKit` takes a `shard: { index, count }` option
(numbered from 1; new `KitShard` type), and plays only the option set and seat count combinations
of that shard, combination `k` (counting every rules version's, in order) going to shard
`k mod count + 1`. The checks that play no game (the manifest, the static checks) run in every
shard, and the shards of a run together play exactly its games. A fast-mode run can't be sharded,
and an invalid shard is a `RangeError`. `KitReport` gains `combos`, the number of combinations
played, `allCombos`, the whole run's number, and `comboDigest`, a fingerprint (not cryptographic)
of the whole run's combination list (rules version, resolved options, seat count), the same in
every shard of one run.

**Seeds changed.** A combination's games now take their seeds from its number alone: game `g` of
combination `k` uses `seed + k * 2^20 + g`, so a shard plays each combination exactly as the whole
run does, and a failure's reported seed is the same in both. The kit therefore plays different
games from before (as many, with the same checks). `games` may be at most `2^20 − 2 × pairs − 1`,
where `pairs` is the mode's isolation pairs per combination (3 fast, 20 full). Seeds stay 32-bit,
so a run from the default seed may have at most 4,096 combinations; one with more fails rather
than repeat another combination's games.

**Non-vacuity per combination in full mode.** The rule that at least half of the perturbation
samples taken in progress must change another viewer's view (or, under `hiddenFromEveryone`, the
state) is now judged for each option set and seat count on its own in full mode, so no combination
hides behind the others and a shard judges each as the whole run does. Fast mode, where a
combination may have only three games, still judges each rules version as a whole. The failure
names the seat count and the options.

**Migration.** A module whose perturbations change another viewer's view in under half of one
combination's samples, while its rules version as a whole passes, now fails the full kit. Look at
that option set and seat count: if its hidden information really is visible to no other viewer
in most states (empty hands late in a short game, say), that combination needs states where it
is, or `perturbHidden` isn't re-dealing everything the viewer can't see.

**Views and summaries are checked as served.** The schema check now parses the JSON the framework
serves rather than the value the module returned, so a `NaN` is checked as the `null` a client gets,
an `undefined` property as absent and a `Date` as its ISO string. A module whose view only passed
its schema as a JavaScript value (a `z.date()` field, say) now fails; make the schema describe the
JSON.

The kit is also cheaper with the same checks: each distinct view and summary JSON is checked
against its schema once per step, rather than once per viewer, and the secrecy checks compare
perturbed views with the JSON each viewer was already served at that step instead of building and
serialising those views again. Under `hiddenFromEveryone`, which counts perturbations by the state,
the kit no longer builds every other viewer's perturbed view just to count them.
