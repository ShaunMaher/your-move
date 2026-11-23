# Spec v0.6 re-review — resolution record

Re-reviews of DRAFT v0.6 by the picky reviewer (CHANGES REQUIRED) and the security reviewer (PASS
WITH FINDINGS), both 2026-11-23. All findings applied in DRAFT v0.7. One line per finding: fixed
(where) or rebutted (why).

## Owner decisions folded into v0.7

- **Q3 resolved**: never reveal whether an email has an account. Adding by email always gets the
  same response, work and timing (onboarded user → invitation; unknown or un-onboarded → email-invite
  seat; suppressed or over cap → seat, no email; blocked → `inert` seat). `NOT_A_PLAYER`, the
  `invite` flag and the "isn't playing yet" step removed; typed addresses shown back before Create;
  creator sees typed address until accepted. (01 F5/G2/G3, 02 §4, 04 `game_players`, 05 `POST
  /api/games`, 06 §6.1–6.6, 07 §1.1, 08 T4/§4/§7, 10 M4, open-questions Q3.)
  - Consequence: **adding by email never auto-joins**, so `whoCanAddMe = "anyone"` was removed
    (it could only work by revealing accounts). `whoCanAddMe` is now `pastOpponents` (default) |
    `nobody`; auto-join applies only to past opponents picked from the list. Q23 is resolved by Q3.
- **Q2 resolved for the proof of concept**: the owner's Google Workspace domain — `smtp` provider to
  Gmail SMTP on Docker, new `gmail` provider (Gmail API, service account with domain-wide delegation
  limited to `gmail.send`) on Workers; `GMAIL_SERVICE_ACCOUNT_JSON`, `GMAIL_SENDER`; SPF/DKIM/DMARC
  verified before go-live; RFC 8058 headers kept. (09 §1–2, 08 assets/T15, 10 M2, open-questions Q2.)

## Picky carry-overs (partially fixed in v0.6)

- R-2: fixed via R2-9.
- R-6: fixed via R2-2.
- R-8: fixed via R2-4 and R2-15.
- R-9: fixed via R2-13.
- R-10: fixed via R2-1 and R2-11.
- R-13: fixed via R2-14.
- R-16: fixed via R2-5.
- R-26: fixed via R2-6.
- R-29: fixed via R2-7.
- R-33: fixed via R2-20.

## Picky findings

- R2-1 fixed: `GET /api/games/:id/history` (05); `history` removed from words and paths views (words §10.4, paths §7); shell drawer and `HistoryItem` read the endpoint (02 §3, §5; 07 §1).
- R2-2 fixed: decline or timeout before a first action → framework-only `declined` ending (not logged, state frozen, ranks NULL, `final_views` written) if < min would remain, else logged and dispatched with `out_reason = declined`, excluded from ranking (02 §4, §5; 04 `game_players`, `game_actions`; 05; words §5, §10.6; paths §5; 01 G11; 08 T26).
- R2-3 fixed: `players[].playerId` for the creator in the lobby; remove-seat scoped to the game, `404` otherwise, own row refused (05).
- R2-4 fixed: dictionaries are a framework resource kind with framework config `DICTIONARIES_ENABLED`, `DICTIONARY_UPLOADS`, `DICTIONARIES_EXTRA`; `GAMES_WORDS_*` keeps ruleset settings and the default dictionary (02 §2.1 rules 7–8, 03 §10, 05 config/catalog, 09 §1, words §9.3, §9.5, §10.1, Q18).
- R2-5 fixed: `setup` takes no resources; the kit replays with an empty provider; broken fixture that reads resources in `setup` (02 §2, §2.1 rule 6, §6).
- R2-6 fixed: one shape everywhere — `400 INVALID_OPTIONS { detail: { code } }`; authorisation failure after resolution uses the kind's `unknownCode` (02 §2.1 rule 7, 03 §10, words §9.5, 10 M6).
- R2-7 fixed: `validateStart` at create (`409 INVALID_SEATS`, nothing stored); an automatic start that fails leaves the lobby waiting and the trigger succeeds (02 §4, 05).
- R2-8 fixed: the lobby `declined` check runs only on decline/leave/remove; every `invited` row counts whatever its delivery; link revoke/expiry never ends a lobby (02 §4, 05, 06 §6.8).
- R2-9 fixed: every clock restart resets `timeout_reminders_sent` (02 §2.3, §4; 03 §8).
- R2-10 fixed: `resources[].downloadUrl` on the envelope for public dictionaries (05, words §9.4).
- R2-11 fixed: `final_views` written on every terminal status after start; GET uses them for any such game (02 §5, 04, 05).
- R2-12 fixed: `endReason` on envelope and summary; lobby summary is framework `Text` (05).
- R2-13 fixed: create-time range error renamed `INVALID_SEAT_COUNT` (400); `INVALID_SEATS` is the 409 `validateStart` error at create and start (02 §2.2, §4; 05).
- R2-14 fixed: race list adds sweep-timeout vs last-second move, accept-vs-remove, accept-vs-cancel, remove-vs-join, auto-starting claim/accept (03 §5.2; 10 M3 refers to it).
- R2-15 fixed: shallow merge of remembered options, retry without them on rejection; catalog `defaults` filtered through `resolveOptions` (05).
- R2-16 fixed: `ResourceRequest = { kind, id, version? }`; words returns `dictionaryVersion` (02 §2, 04 `game_resources`, words §10.1).
- R2-17 fixed: `game_players.removed_at` compared with `join_links.created_at` (04, 06 §6.8).
- R2-18 fixed: worst-case lookup reservation before the module runs, counting `has()` wrapper aborts with `429`, refund of unused budget (03 §10, 05 `/actions` step 6, 08 §4, words §9.5).
- R2-19 fixed: joining through a link while holding an invitation (any delivery) accepts it (02 §4, 05 join, 06 §6.8).
- R2-20 fixed: glossary adds seat order, open seat, email-invite seat/claim, delivery, `whoCanAddMe`, onboarding, turn timeout/deadline, `Text`/`describe`, final views, distribution, operator/uploaded dictionary, edge notch, tile id, draw-order token (README).
- R2-21 fixed: paths check order `WRONG_PHASE` → `OUT_OF_RANGE` (renamed from `NOT_EDGE_NOTCH`) → `NOTCH_OCCUPIED`/`NOT_IN_HAND` → `SELF_ELIMINATION_AVOIDABLE` (paths §7).
- R2-22 fixed: non-joined rows are kept after start with `seat` NULL (unfilled → `dropped`) so blocks can target anyone who shared a game; block checks apply to all invitees; blocking a lobby co-member removes (creator) or declines/leaves (others); Block on the invitation screen (02 §4, 04, 05 §Blocks, 06 §6.1, §6.10, 07 §1).
- R2-23 fixed: invitation email to existing users specified — template, category `nudges`, instance cap, never for hidden/inert, sent on creation/claim via `waitUntil`, not the sweep (06 §6.2, 03 §7).
- R2-24 fixed: shared `packages/dictionary/removals-global.txt` applied to operator and uploaded lists (words §9.1, §9.5).
- R2-25 fixed: `LOG_LEVEL` moved to the main config table (09 §1).
- R2-26 fixed: lifecycle transitions and non-transition game endpoints split into two tables (05).
- R2-27 fixed: `403 ONBOARDING_REQUIRED` listed on accept, join lookup, join and the games list (05).
- R2-28 fixed: M2 onboarding is display-name only and its acceptance covers 06 §3–§4; age rules are M4 (10).
- R2-29 fixed: transition list includes `leave` (02 §4); paths last standing is "one player remains" (paths §5); Q11 reminder wording; `SECURITY.md` wording (08 §7); `OptionsForm.value` is the unresolved input (02 §3); `ModuleConfig`, `SubmitResult`, `FrameworkError`, `ResourceRequest`, `ListSummary` defined (02 §2).

## Security carry-overs (partially fixed in v0.6)

- S-1: fixed via S2-1, S2-2, S2-6 (and Q3).
- S-7: fixed via S2-11.
- S-8: fixed via S2-3.
- S-9: fixed via S2-4.
- S-carry-T12/T17: fixed via S2-3.
- S-carry-T20: fixed via S2-5.
- S-carry-T24: fixed via S2-1.

## Security findings

- S2-1 fixed: no automatic start while a join link is live or any seat was filled through one; past-opponent pairs only between players who both acted; link joiners only via the creator's "Add <name> to your players?" (`POST /api/games/:id/add-player`) (02 §4, 04 `past_opponents`, 05, 06 §6.8–6.9, 07 §1, 08 T24, 10 M4).
- S2-2 fixed: lobby endings (incl. account-deletion cancels) send realtime only; "game ended" pushes only for games that reached `active` (02 §4, §8; 03 §7; 04 §Account deletion; 08 T18; 10 M4).
- S2-3 fixed: unsubscribe moved to `/api/email/unsubscribe` (always server-handled, covered by `run_worker_first` and the service-worker denylist), `no-store`, M4 e2e on both targets with the SW active (05 §Email links, 03 §9, 07 §4, 08 T6, 09 §2, 10 M4).
- S2-4 fixed: invites claimed only when onboarding completes; un-onboarded accounts treated as unknown; "I'm under `MIN_AGE`" deletes the account at once (`POST /api/me/under-age`); sweep deletes un-onboarded accounts after 7 days; `403 ONBOARDING_REQUIRED` on list, create, accept, lookup, join (04 `users`, §Account deletion; 05; 06 §2, §3.1, §5, §6.4; 03 §8; 07 §1; 10 M4).
- S2-5 fixed: blocks between every pair, re-checked on accept (→ declined + `404`) and at start (later joiner removed); blocking a lobby co-member takes effect at once (02 §4, 05, 06 §6.10, 08 T20).
- S2-6 fixed: invited users' names and ids hidden until accepted; creator sees the typed address, others "Invited"; join lookup lists joined players only (05 §Common types, 06 §6.1, §6.8).
- S2-7 fixed: display-name changes limited to 3 per 30 days and logged (`display_name_changed`) (06 §5, 04 `auth_events`, 05, 08 §4).
- S2-8 fixed: inbound cap 1/day per creator and 3/day total; over-cap invitations go to a collapsed *Hidden invitations* list (`delivery = hidden`) rather than being dropped; outbound cap of 10 email invitees/day per user (Q3: counted for every typed address) (04, 05, 06 §6.6–6.7, 07 §1, 08 §4).
- S2-9 fixed: as R2-3 and R2-17; `removed_at` column (04, 05, 06 §6.8).
- S2-10 fixed: non-vacuity check for `perturbHidden` (modules declare `hiddenInformation`), null-viewer perturbation, no-op and public-view-leak broken fixtures (02 §2, §6).
- S2-11 fixed: a timeout before a first action follows the decline rule (02 §4; 08 T26).
- S2-12 fixed: join page `history.replaceState` to `/join`; `sessionStorage` entry cleared after join or `404` (06 §6.8, 07 §1).
- S2-13 accepted as residual (owner's `whoCanAddMe` design): documented under T20 and in 08 §7's accepted risks; narrowed by the both-acted rule and `whoCanAddMe = nobody`.
- S2-14 fixed: modules receive only their own prefix-stripped keys; type ids `^[a-z][a-z0-9]*$`; no config values in startup errors (02 §2.1 rule 8, 09 §1).
- S2-15 fixed: `MIN_AGE` integer ≥ 13 validated at startup; attested threshold stored (`age_attested_min_age`); raising it re-prompts (04, 06 §5, 09 §1).
- S2-16 fixed: as R2-18 (budget loaded in the first read batch, reservation, sentinel abort; exhausted budget also blocks moves, documented) (03 §10, 08 §4).
- S2-17 fixed: per-IP limit covers join as well as lookup; link joins count only against the joiner's limits, never the creator's caps (05 join, 06 §6.8, 08 §4).
