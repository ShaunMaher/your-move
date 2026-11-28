# Pairs spec review: resolutions

This record covers the review of `alpha-pairs-spec`: the new game spec `docs/spec/games/pairs.md` (the memory game, working name "Pairs") and its edits to 02, 07, 10, the open questions and the findings (spec v0.9.48). It had two rounds of the picky review (PS-P, PS-P2) and of the security review (PS-S, PS-S2). The owner settled the disagreements and verified the last fixes.

Owner decisions:
- records name no card (Q31, PS-P-5 over PS-S-6);
- a move limit, made quadratic (`4·pairs²`) after a simulation showed a linear one ended many weak-memory games early (PS-S-1, PS-P-11, PS-P2-1, PS-S2-1);
- `hiddenFromEveryone` kept strict, identical views for every viewer, enforced by the kit in the engine slice (PS-S-2, PS-P2-2);
- the name is a working name for Shaun (Q32, PS-P-6).

| ID | Outcome | Where |
|---|---|---|
| PS-S-1, PS-P-11, PS-P2-1, PS-S2-1 | Fixed (owner decisions). A move limit ends every game, and `maxActions` follows from it with a proof. `randomAction` is uniform and reads no face. The kit must reach `all-found` on every grid. | pairs §6, §8.7, §10; 02 §6.4 |
| PS-S-2, PS-P-3, PS-P-4, PS-P2-2, PS-S2-2 | Fixed (owner decision). One definition of `hiddenFromEveryone`, checked by the kit. The SDK, the guide and the existing deck-only kit test are aligned in the engine slice. | 02 §2, §6.3; 10 §Pairs game |
| PS-S-3 | Fixed. Explicit `apply` branches, invariants, and an independent oracle test of which faces show. | pairs §8.1, §8.2, §8.7, §10 |
| PS-S-4 | Fixed. No face in the DOM or the accessibility tree once hidden. The shell refetches a page restored from the back/forward cache. | pairs §9; 02 §3; 07 §4 |
| PS-S-5 | Accepted: F-27. | `docs/security/findings.md` |
| PS-S-6, PS-P-5 | Settled: records name no card (Q31). | pairs §4, §8.5 |
| PS-S-7, PS-S-8, PS-S2-3 | Noted. | pairs §6, §8.8 |
| PS-P-1 | Fixed. Every ending clears the turn's cards, and the finished view is defined. | pairs §6, §8.2, §8.4, §10 |
| PS-P-6 | Open for Shaun: Q32 (the name). | open-questions |
| PS-P-2, PS-P-7 to PS-P-10, PS-P-12 to PS-P-16 | Fixed. | pairs §2, §8, §9; 07 §2, §6; 10 |
| PS-P2-3 to PS-P2-10 | Fixed. | pairs §8.6, §8.7, §9; 02 §3; 07 §4; 10; Q32 |
