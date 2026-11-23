# Review of spec v0.5 → fixes in v0.6

Picky review (R-n, verdict CHANGES REQUIRED) and security review (S-n, verdict FAIL) of DRAFT v0.5,
2026-11-23. Owner decisions: S-1 → "past opponents only" (`whoCanAddMe`); S-9 → minimum-age
confirmation + parent-account guidance before the path game.

## Picky review

- R-1 fixed: `seatStatus(state)` added to the contract; framework stores newly-out seats each transition (02 §2, §4; 04 invariant 3).
- R-2 fixed: turn timeout is framework-owned, integer 1–30 days, module supplies `defaultTurnTimeoutDays`; stored `games.turn_timeout_days`; reminders at 50 % and 24 h before (02 §4; 04 games; 05 POST /games; words §10.1; paths §6; Q11).
- R-3 fixed: seat leaves `toAct` once its action is accepted; clock (re)start rules; sweep handles overdue seats one at a time in seat order with reload/re-check (02 §2.3, §4; 03 §8).
- R-4 fixed: `randomAnyAction`; perturbation covers validate/preview incl. detail for illegal actions, records (same and different draws unless `publicRandomness`), summary, toAct, seatStatus, result-null (02 §2.1 rule 4, §6.3).
- R-5 fixed: broken fixture modules the kit must fail; turn sanity replaced by module-checkable checks; `maxActions` in contract (02 §6; 10 M1).
- R-6 fixed: decline before first action ends `declined` with no ranking if fewer than min would remain, else resignation; active → declined edge (02 §4; 05 lifecycle; 01 G11).
- R-7 fixed: freed lobby seat reopens; lobby ends `declined` only when joined + invited < min and no live join link (02 §4).
- R-8 fixed: `resolveOptions`, `catalog`, `configSchema` with namespaced `GAMES_<TYPE>_*` config; `settings.lastOptions[gameType]` / `lastGameType` (02 §2, §2.1 rule 8; words §10.1; 09 §1; 04 users; 05 catalog).
- R-9 fixed: restored config/catalog/health, push subscriptions, blocks, email links/unsubscribe, errors table with lifecycle error codes (05).
- R-10 fixed: stored `describe` text per log entry and per-seat final summaries; `versions` on `GameClientModule`; client renders every released version (02 §3, §5, §7; 04 game_actions, games.final_views).
- R-11 fixed: token hand-over when holder is out, "next" reference point, eliminated mover doesn't draw (paths §3, §4).
- R-12 fixed: empty-handed seats never in `toAct`, `skipped` in the record; termination bound = players + 35 + players (paths §3, §7; 02 §2.3).
- R-13 fixed: reference module covers 2–4 players, hidden hand, elimination, simultaneous secret phase; M3 acceptance lists the lifecycle tests; race lists aligned (10 M1/M3; 03 §5.2).
- R-14 fixed: framework `seatOrder: join | random` with recorded draw; `game_players.joined_at`; module `firstPlayer` options removed (02 §4; 04; words §2; paths §2; Q5).
- R-15 partly fixed: added `recordSchema`, `previewSchema`, `errorCodes`, `test.maxActions`, `view(state, Seat | null)`. Different fix for names (`Text` with `{seat}` placeholders rendered by the framework, so `summary`/`describe` need no names) and for the words view's dictionary metadata (moved to the envelope's `resources`, so `view` needs no `res`). Rebutted `res` for `onResign`/`onTimeout`: per R-16 those MUST NOT read resources (02 §2, §2.1 rule 6; words §10.4).
- R-16 fixed: replay dispatch by kind; `apply`/`onResign`/`onTimeout` receive no resources (02 §2.1 rule 6, §5; 04 invariant 1).
- R-17 fixed: only module transitions are logged (`action`, `resign`, `timeout`, `decline` after start); `action_count` counts log rows (02 §5; 04 game_actions).
- R-18 fixed: server-initiated transitions retry up to 3 times; outcome when the state moved on defined (02 §4; 03 §5.2; 05 join).
- R-19 fixed: per-player `deadline` in the envelope (05 common types).
- R-20 fixed: adjacency `n XOR 5` (verified against the numbering), rotation `(n + 2k) mod 8`, edge-notch formula, marker position as (faced square, notch), canonical tile order (paths §1).
- R-21 fixed: collision defined as head-on traversal of the same path, always also an edge exit; same-notch only an assertion; board full = no surviving player holds a tile (paths §3, §5, §9).
- R-22 fixed: responsive square size fits 320 px; two-step marker placement with ≥ 44 pt buttons; accessible names (paths §8; 07 §6).
- R-23 fixed: standard competition ranking (02 §4; paths §5).
- R-24 fixed: deletion as resumable per-game transitions (real resign/leave/decline), user row last (04 §Account deletion).
- R-25 fixed: lobby expiry 14 days from `created_at`, not extended; `invites.expires_at` the same (02 §4; 04 invites; 06 §6.5).
- R-26 fixed: `GameError { code, detail?: unknown }`; `INVALID_WORDS` detail; reserved framework codes rejected by the kit (02 §2, §2.2; words §10.3; 05 §Errors).
- R-27 fixed: sweep lists join-link expiry, blob purge and orphan cleanup, timeout reminders, deletion resume (03 §8).
- R-28 fixed: version check before turn check; client refetches on both (05 actions; 07 §2).
- R-29 fixed: `validateStart(options, seats)` → `409 INVALID_SEATS` (02 §2, §4; words §10.1; 05 start).
- R-30 fixed: CPU budget in the kit with per-module `worstCase` inputs; M1 acceptance (02 §6.6; 08 T25; 10 M1).
- R-31 fixed: `game_resources` table; `games.dictionary_id` dropped (04).
- R-32 fixed: all listed stale references (words §8.1 path, 07 `@app/game-words`, 04 secrecy ref, 03 randomness ref, 03 "M6", Q18 M6, 01 G3/G5, README Invite, 02 responsibilities, 08 T18, 07 icon glyph, 09/Q12 example name).
- R-33 fixed: glossary split into framework / words / paths terms, with the missing terms (README).
- R-34 fixed: duplicate roadmap bullet removed; T23 before T24; stray blank lines; `WordsRecord`; `final.racks`; `seats` default wording; email-invite seats can't decline via API (stated in 05).

## Security review

- S-1 fixed (owner decision): `whoCanAddMe` (default past opponents) with invitations that send no push; past opponents formed only at finish, link joiners only with the creator; `remove-seat`; per-target inbound cap (silent `suppressed`); active-game caps count the creator's own games only; T20/T24 updated (02 §4; 04 game_players, past_opponents; 05; 06 §6.2, §6.7–6.9; 08 T20, T24, §4).
- S-2 fixed: framework `ResourceProvider.authorizeForNewGame` at create; foreign/deleted upload = `UNKNOWN_DICTIONARY`; T11 covers dictionaries and join links; tests with foreign/deleted/nonexistent ids (02 §2.1 rule 7; 03 §10; words §9.5; 08 T11; 10 M6).
- S-3 fixed: structural/rack checks before any lookup; preview takes a full action only; "are these words valid" wording removed; per-word `serverOnly` lookup limits per user and per game (words §9.5, §10.3; 05 preview; 08 T22, §4).
- S-4 fixed: quota counts unpurged blobs (`purged_at`); instance-wide byte/daily caps; account maturity; temporary key + orphan sweep; separate Docker volume (words §9.5; 04 dictionaries; 03 §8; 08 T21, §4; 09 §1, §4).
- S-5 fixed: kit covers summary, toAct, seatStatus, records; only the viewer's `final_views` entry is returned; 500s carry no detail; no input values in logs (02 §6; 05 GET game, §Errors; 08 T8; 09 §5).
- S-6 fixed: non-joined rows deleted at start; membership defined by row state; `yourSeat` from the member's row; route test in M3 (02 §4; 04 §Membership; 10 M3).
- S-7 fixed: framework timeout 1–30 days shown on invitations; decline before first action not a loss when it leaves too few players (02 §4; 08 T26).
- S-8 fixed: restored email links/unsubscribe, push, blocks, catalog (viewer's own uploads only, no blob key/hash/size), config (non-sensitive) (05).
- S-9 fixed (owner decision): `MIN_AGE` (default 13) confirmed at onboarding, full-name warning, privacy page wording, no marketing to children, minors in assets; scheduled in M4 before the path game; Q20 split into decided/open (06 §5; 07 §1; 08 §1, §5; 09 §1; 10 M4/M5; Q20).
- S-10 fixed: envelope returns `{ active, expiresAt }`; URL only in create/rotate response (04 join_links; 05).
- S-11 fixed: token in URL fragment with `POST /api/join/lookup`; log `route` is the pattern; return path in `sessionStorage`, same-origin `/join` only; explicit Join tap (05; 06 §6.8; 07 §1; 09 §5).
- S-12 fixed: open seat defined; declined/left/removed users get `404`; lobby join/leave/remove send no push; join retries (02 §4; 06 §6.8; 05 join).
- S-13 fixed: server-generated UUID blob keys, filesystem key regex and path check, operator id format, no cross-user dedup (words §9.5; 04 dictionaries; 08 T21).
- S-14 fixed: raw-text binary search with no index build; byte-sized LRU; per-user distinct `serverOnly` loads limit; CPU budget in the kit with worst-case inputs (words §9.4; 03 §10; 08 T25, §4; 02 §6).

### Consistency items (info)

- S-info-1 fixed: T6 lists both exemptions (unsubscribe; upload for JSON only) (08 T6; 05 conventions).
- S-info-2 fixed: assets include licensed/uploaded word lists; data collected includes uploads and rights attestations (08 §1, §5).
- S-info-3 fixed: T18 requires push text from public `describe` text only (08 T18; 03 §7).
- S-info-4 fixed: `invites` stores `email_hash` only (04 invites; 08 §5).
- S-info-5 fixed: deletion is resign/leave with retry per game, then user-level steps, resumable (04 §Account deletion).
- S-info-6 fixed: `removals.txt` applied to uploads during validation (words §9.5).

### Controls not carried through (08 → other docs)

- S-carry-T11 fixed: ownership for dictionaries, join links and blocks (08 T11; 05 blocks; 02 §2.1 rule 7).
- S-carry-T12/T17 fixed: push and unsubscribe routes in 05.
- S-carry-T20 fixed: blocks checked between every seated/invited pair on create and join (06 §6.1, §6.8; 08 T20).
- S-carry-T24 fixed: remove-seat and the other T24 controls (see S-1, S-10–S-12).
- S-carry-T25 fixed: CPU budget in the 02 §6 kit (see S-14).
- S-carry-T22 fixed: residual risk restated with the new controls (see S-3).

## New open questions

- Q23: seats claimed from email invites follow `whoCanAddMe` like everyone else (invitation to accept rather than auto-join). Default: yes.
