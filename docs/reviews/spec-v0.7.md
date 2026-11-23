# Spec v0.7 final review — resolution record

Final reviews of DRAFT v0.7 (branch `spec-v0.7`, MR !1) by the picky reviewer (CHANGES REQUIRED)
and the security reviewer (PASS WITH FINDINGS), both 2026-11-23. All findings applied in DRAFT
v0.8. One line per finding: fixed (where) or rebutted (why).

## Owner decisions folded into v0.8

- **Gmail (R3-3, S3-4, S3-5, S3-11)**: domain-wide delegation and the Gmail SMTP app-password route
  are dropped. One `gmail` provider (Gmail API) on both runtimes, with an Internal OAuth client and
  a `gmail.send`-only refresh token from a dedicated sender user that has IMAP/POP disabled.
  *Sent*-folder copies are an accepted proof-of-concept residual with mitigations. A shared MIME
  builder handles header encoding. `*_FILE` secrets on Docker. The sender-user and OAuth setup is
  an operator step (09 §2).
- **Invite claims are not game transitions**: they update only the claimed row, don't bump the
  version and are invisible to other members.
- **Decline wording**: `onResign` takes a reason; a decline (or a timeout before a first action) is
  logged as `decline` and recorded as "declined", never "resigned".

## Picky findings

- R2-4 (partial) fixed: `checkConfig(config, catalog)` hook run at startup; words default-dictionary check moved there (02 §2 and §2.1 rule 8, 09 §1).
- R2-15 (partial) fixed: catalog `defaults` follow the create path's rule (05 §Catalog).
- R3-1 fixed with S3-3: per-pair limits keyed by (creator, `emailId`) for typed addresses (05 `POST /api/games`, 06 §6.1 and §6.7, 08 §4).
- R3-2 fixed: one push rule — auto-join push naming the creator, generic invitation push, nothing else in the lobby (02 §4 and §8, 03 §7, 06 §6.2, 08 T18).
- R3-3 fixed: no domain-wide delegation; OAuth refresh token, `gmail.send` only (08 T15, 09 §1–2, Q2).
- R3-4 fixed: the forwarded-IP header is required only on routes that use a client IP; `/api/health` exempt; test added (08 §4.1, 10 M4).
- R3-5 fixed with S3-8: only literal duplicates are rejected; an address resolving to a user already in the request becomes an `inert` email-only seat (04 `game_players.delivery`, 05, 06 §6.1).
- R3-6 fixed: `yourInvitation: "normal" | "hidden" | null`; hidden excluded from the default list; `unread` false for hidden (05, 07 §1).
- R3-7 fixed: the sweep claims stranded email seats; create-vs-onboarding and the other claim races added (03 §5.2 and §8, 06 §6.4); claims apply the inbound cap (S3-6).
- R3-8 fixed: the framework-only `declined` ending sets the decliner `out`/`declined`; invariant 3 scoped to `active` games (02 §4, 04 invariants).
- R3-9 fixed: `onResign(…, reason)`; `decline` record type and wording in paths, note in words (02 §2.1 rule 9, paths §5 and §7, words §10.6).
- R3-10 fixed: as R2-4.
- R3-11 fixed: as R2-15.
- R3-12 fixed with S3-10: re-prompt keeps `onboarded_at`, gates the same endpoints, sweep deletes only `onboarded_at IS NULL`, `needsOnboarding` on `GET /api/me`, under-age exit runs the full deletion for re-prompted users (04, 05, 06 §5, 03 §8).
- R3-13 fixed: any seat, the creator's included, may decline before its first action (02 §4, 05 lifecycle table).
- R3-14 fixed: the lobby `declined` check runs only on decline and leave, never on remove (02 §4 and diagram, 05, 10 M3).
- R3-15 fixed: link join by an invited user → `joined_via = invitation`; auto-start blocked only by `joined` rows with `joined_via = join_link` (02 §4, 04, 05, 06 §6.8).
- R3-16 fixed: email invitees 10/day and 5/h (06 §6.6, 08 §4).
- R3-17 fixed: compose files are `apps/node/docker-compose.tunnel.yml` and `docker-compose.caddy.yml` everywhere; tunnel compose is an M4 deliverable with acceptance (03 §3, 09 §4, 10 M4).
- R3-18 fixed: the GitLab hostname removed from Q9.
- R3-19 fixed: decline and sign-up listed as T4 residuals needing a real person; declined and removed rows show only their state (05, 06 privacy note, 08 T4).
- R3-20 fixed: `ResourceMeta`, `ResourceCatalog` and `Resources` defined (02 §2).
- R3-21 fixed: "both `whoCanAddMe` settings" (10 M3).
- R3-22 fixed: claims removed from the auto-start triggers and the transition list (02 §4, 03 §5.2).
- R3-23 fixed: `GMAIL_SENDER` is the dedicated user's own address, no alias (09 §1).
- R3-24 fixed: engine versions stay registered while any `lobby`/`active` game uses them (02 §7).
- R3-25 fixed: actual lookups always charged; unused reservation refunded in the batch or by one follow-up write (03 §10).
- R3-26 fixed: `canAddPlayers`/`add-player` exclude blocked pairs (05).

## Security findings

- S3-1 fixed: rows never joined (`joined_at` NULL) show no name or user id to anyone in any state; remove and decline cases added to the M4 parity test (02 §4, 04, 05 §Common types, 07 §1, 10 M4).
- S3-2 fixed: past-opponent pairs never written for blocked pairs; `add-player` → `404` on a block; explicit block check for `userId` invitees; invariant 6 (02 §4, 04, 05, 06 §6.1 and §6.9, 08 T20).
- S3-3 fixed: as R3-1.
- S3-4 fixed: as R3-3.
- S3-5 fixed (accepted residual): dedicated sender user, IMAP/POP off, regular *Sent* purge, privacy-page disclosure, move to a transactional provider before growth (07 §1, 08 §5 and §7, 09 §2).
- S3-6 fixed: claims apply the full §6.1 block rule against every row and the inbound cap (06 §6.4, 08 T20).
- S3-7 fixed: claims are row-level updates with no version bump or realtime event for other members; sign-up, accept and decline listed as T4 residuals (02 §4, 03 §5.2, 06 §6.4, 08 T4).
- S3-8 fixed: as R3-5.
- S3-9 fixed: `TRUST_PROXY_PEERS`; two Docker networks (`front` internal, `egress`); Pseudo IPv4 must not be "Overwrite" (08 §4.1, 09 §1 and §4).
- S3-10 fixed: as R3-12.
- S3-11 fixed: shared MIME builder with RFC 2047 encoding and CR/LF rejection, hostile-name tests (T14); no app password, sender user IMAP/POP off (T15); `*_FILE` secrets (09 §1).
- S3-12 fixed: the silent new-account-limit path still inserts a never-emailed challenge (06 §3.2, 08 §4).
- S3-13a fixed: 03 §7 push bullets agree with 06 §6.2.
- S3-13b fixed: as R3-21.
- S3-13c fixed: as R3-16.
- S3-13d fixed: `inert` rows are never accepted; a link join is block-checked against every row (05 `/api/join`, 06 §6.8).
- S3-13e fixed: the under-age exit suppresses invite emails to the address and makes its email seats `inert` (04 §Account deletion, 05, 06 §5).
- S3-13f fixed: F4 says that an invitation push names nobody, while the invitation email (if nudges are on) and the auto-join push name the sender (01 F4).
- Controls not carried through (T15, T14, 08 §5 retention, T4 residuals, T20 invariant) fixed: see S3-4, S3-11, S3-5, S3-7 and S3-2.

No findings were rebutted.

## Focused verification of v0.8 (applied in v0.8.1)

- R4-1 fixed (merged with S4-3): claim guard and sweep add `delivery <> 'inert'` and "no other row in this game for this user"; an inert row's delivery is never recomputed (02 §4 invite claims, 03 §5.2, 03 §8 sweep, 06 §6.4; M4 tests in 10).
- R4-2 fixed: after a remove or decline every row shows only its state ("Removed"/"Declined") to the creator; `invitedAs` only while `invited`; `invite_email` cleared as before (01 F5, 02 §4, 05 §Common types, 06 §6.1, 07 `/g/:id`).
- R4-3 fixed: the creator alone sees the name of a past opponent they picked by `userId` while invited; 02 §4 wording now "to anyone but the creator" (02 §4, 05 `invitedAs`, 07).
- R4-4 fixed (merged with S4-2): only a creator↔`userId` block fails as `INVALID_INVITEES` (indistinguishable from "not a past opponent"); blocks between invitees or with members give the later invitee a silent `inert` seat (06 §6.1, 05 create table, 08 T20; Q3 parity test in 10 M4).
- R4-5 fixed: `otp_challenges.emailed` column; an `emailed = 0` challenge consumes the attempt, runs the comparison and always fails (04 `otp_challenges`, 06 §3.1, §3.2).
- R4-6 fixed: `ResourceMeta.downloadUrl?`, set by the framework for public distribution only (02 §2 types).
- R4-7 fixed: Caddy publishes 80/443 on `egress` and reaches the app over `front`; the app publishes nothing (09 §4 networks).
- S4-1 fixed: for a re-prompted (onboarded) account, "I'm under `MIN_AGE`" signs out only that session and deletes nothing; deletion goes through the step-up path; no-step-up deletion only when `onboarded_at` IS NULL; re-prompt copy addresses the account holder (06 §5, 05 `/api/me/under-age`, 04 §Account deletion, 07 `/welcome`, 10 M4).
- S4-2 fixed: see R4-4.
- S4-3 fixed: see R4-1.
- S4-4 fixed: claims are conditional on `games.version` equal to the loaded version (checked, not bumped), retried up to 3 times; the inbound-cap count is atomic with the claim (02 §4, 03 §5.2, 06 §6.4; 10 M4).
- S4-5 fixed: compose files pin the `front` subnet via IPAM and set `TRUST_PROXY_PEERS` to it plus loopback; the private-ranges default is a logged fallback (09 §1 table, 09 §4 networks, 08 §4.1).
- S4-6 fixed: `pnpm gmail:authorize` uses PKCE + `state`, a 127.0.0.1 loopback redirect, `login_hint=GMAIL_SENDER`, exact scopes `openid email gmail.send` without `include_granted_scopes`, verifies the id_token email and granted scopes, reads the secret from env/file, writes a 0600 file; startup re-checks the scope; T15 qualified for a leaked Internal-client secret; sender user has 2-Step Verification, is never used interactively, and the privacy retention allows for Trash (30 days) and Vault holds (09 §2, 08 T15, 08 §5).
- S4-7 fixed: secret fields redacted in every startup/config error; one trailing newline trimmed from `*_FILE` contents (09 §1).
- S4-8 fixed: `canAddPlayers` keeps listing blocked link joiners; `add-player` is a silent `204` no-op when a block exists (05 envelope and add-player, 06 §6.9, 08 T20, 10 M4).
