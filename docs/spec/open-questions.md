# Open questions

Decisions the owner needs to make. Each has a recommended default the coding agent will use if
unanswered by the time it's needed (milestone in brackets).

| # | Question | Recommended default | Needed by |
|---|---|---|---|
| Q1 | Copyright holder line in `LICENSE` (your name personally, a pseudonym, or "The Project Contributors")? If you're employed, check your employment agreement covers side projects on personal time/equipment. | "The Project Contributors" (current placeholder) | before first public push |
| Q2 | Email provider and sending domain/subdomain? | Resend or Postmark on a dedicated subdomain (e.g. `mail.<domain>`) | M2 |
| Q3 | Keep the "*X isn't playing yet — invite them?*" UX (reveals whether an email has an account, to signed-in users only, rate-limited)? Alternative: always say "Game created — we'll notify them", and silently invite if unknown. Alternative leaks nothing but makes accidental invites to typos more likely. | Keep it as you described | M3 |
| Q4 | ~~Base numbers~~ — resolved: both styles ship as selectable rulesets (words §8.3). | — | — |
| Q5 | Who moves first: game creator or random? Now a framework choice per game (`seatOrder`: join order, creator first / random, 02 §4). | Default `join` (creator first); `random` offered in the new-game flow | M3 |
| Q6 | Domain name and Cloudflare account to deploy to? (Can stay on `*.workers.dev` for testing.) | `workers.dev` until a name is picked | M2 |
| Q7 | OK to ship a `removals.txt` that blocks slurs from play (they're in ENABLE)? | Yes, starting from a small reviewed list | M1 |
| Q8 | Spelling: ENABLE is North American. Want Commonwealth spellings (colour, realise)? Note the main Commonwealth tournament list (Collins) is **not** freely licensed, so we'd add words via `additions.txt` or find a permissively licensed list. | ENABLE only for v1 | M1 |
| Q9 | GitLab: gitlab.com or self-hosted? Affects CI runner images and container registry. | gitlab.com conventions | M0 |
| Q10 | Should the invite email show the inviter's email address (better recognition/anti-spam) or display name only? | Show both (06 §6) | M4 |
| Q11 | Turn timeout: now chosen by the creator per game, 1–30 days (02 §4). Are the module defaults right (words 14 days, paths 3 days) and the reminders (at 50 % and 24 h before)? | As listed | M3 |
| Q12 | Placeholder app name for dev builds? | `Example Games` via `APP_NAME` | M0 |
| Q13 | OTP length: 6 digits (easier to type; odds in 06 §3.4) or 8 digits (≈100× harder to guess; iOS autofill makes length mostly painless)? | 6, with 8 as the first lever if monitoring shows guessing | M2 |
| Q14 | Instance-wide email caps (08 §4: 200 OTP/h, 1,000 OTP/day, 100 invites/day) — right size for your expected group? | As listed | M2 |
| Q15 | Premium layouts: original arrangements with the same counts/feel (current spec), or exact copies of the two commercial boards? Exact copies feel more familiar but carry some trade-dress risk, which matters more because the repo is public. (Scrabulous changed its board layout as well as its name after it was sued.) It's one data file per ruleset, so easy to change later. | Original layouts | M1 |
| Q16 | Display names for the two MVP rulesets (the app can't use the commercial names). | "Classic" and "Casual" | M3 |
| Q17 | Exact mobile-game details for `casual` that I'm not certain of: swap order, minimum bag size for swaps, and the scoreless/pass end-game rule. Can you check in the app before you delete it? | `returnThenDraw`, 7, 6 scoreless turns | M1 |
| Q18 | Who may upload word lists: every signed-in player, or only accounts the operator allows? Open uploads are simplest for a friends-only instance; an allow-list reduces copyright exposure if the instance ever opens up. | Every player whose account is ≥ 7 days old or has finished a game, with `GAMES_WORDS_DICTIONARY_UPLOADS=false` as the off switch | M6 |
| Q19 | NASPA membership (to license NWL as an operator dictionary for your instance). **Open — owner deciding; no default action.** | — (open) | M6 |
| Q20 | Children. **Decided (2026-11-23):** before the path game ships (M4), a configurable `MIN_AGE` (default 13) is confirmed at onboarding; the privacy page says children play through a parent's account; the name screen warns against full names; copy doesn't market to children; `whoCanAddMe` defaults to past opponents. **Still open:** (b) adult-managed child profiles with no email, signed in on a device using a code the adult generates, with restricted features — scope and privacy review for M7. | (b) specced in M7 after a privacy review | M7 |
| Q21 | Name and theme for the path game (placeholder "Paths"). Theme ideas: lanterns on a night river, hiking trails, space lanes. | "Paths", neutral SVG style | M5 |
| Q22 | Simplification made in v0.5: in a word game started by **email invite**, the creator can no longer play their opening move while waiting. The game sits in the lobby until the invitee signs up and accepts. (Games against past opponents still start immediately.) OK? | Accept the simplification | M4 |
| Q23 | When someone signs up from an email invite, their seat follows the same `whoCanAddMe` rule as everyone else, so with the default they see an invitation to accept right after onboarding, rather than being auto-joined (06 §6.4). Safer, one extra tap. OK? | Yes, same rule for everyone | M4 |
