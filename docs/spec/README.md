# Specification

Status: **DRAFT v0.6** (v0.2 revised after picky + security review; v0.3 adds selectable rulesets and dictionaries; v0.4 adds bring-your-own dictionaries; v0.5 turns the product into a multi-game framework, 2026-11-21; v0.6 applies the v0.5 picky + security review — contract hooks, framework-owned timeouts and seat order, invitations and `whoCanAddMe`, join-link hardening, upload quotas, minimum age, paths geometry — 2026-11-23, traceability in `docs/reviews/spec-v0.5.md`). Nothing is implemented yet. These documents are the source of truth for
the coding agent; if code and spec disagree, the spec wins until the spec is changed on purpose.

The product has no name yet. Everywhere a name would appear, use the configured value
`APP_NAME` (see [09-operations.md](09-operations.md)). Never hard-code a product name in code,
copy, emails, manifests, package names or Docker image names.

| # | Document | What it covers |
|---|----------|----------------|
| 01 | [Product](01-product.md) | Goals, users, scope, non-goals, user stories |
| 02 | [Game framework](02-game-framework.md) | Game module contract, lifecycle (lobby, seats, turns, timeouts), secrecy, replay, test kit |
| G1 | [Game: words](games/words.md) | Crossword-tile word game: rules, rulesets, dictionaries, module contract |
| G2 | [Game: paths](games/paths.md) | Path-laying tile game for 2–8 players |
| 03 | [Architecture](03-architecture.md) | Repo layout, runtimes (Cloudflare + Docker), storage, realtime, Durable Objects |
| 04 | [Data model](04-data-model.md) | Tables, columns, invariants |
| 05 | [API](05-api.md) | HTTP + WebSocket contract |
| 06 | [Auth & accounts](06-auth.md) | Email OTP, sessions, display names, invites |
| 07 | [Frontend & PWA](07-frontend.md) | React app, mobile layout, interaction, PWA/iOS specifics |
| 08 | [Security](08-security.md) | Threat model and required controls |
| 09 | [Operations](09-operations.md) | Configuration, email delivery, deploy targets, observability |
| 10 | [Roadmap](10-roadmap.md) | Milestones and acceptance criteria |
| -- | [Open questions](open-questions.md) | Decisions we still need from the owner |

## Conventions used in these docs

- **MUST / SHOULD / MAY** carry RFC 2119 meaning.
- "Server" means the shared application core, regardless of runtime (Worker or Node).
- "Runtime adapter" means the thin per-platform layer (Cloudflare or Node) that plugs storage,
  realtime, email and secrets into the shared core.

## Glossary

Framework terms:

| Term | Meaning |
|------|---------|
| Game module | A self-contained game (rules engine + board UI) plugged into the framework (02). |
| Game shell | The framework UI around every game: list, new-game flow, lobby, header, menu, history (02 §3). |
| Seat | A player position in a started game, numbered from 0; seat order is turn order, set by the framework's seat order (02 §4). |
| Lobby | A created game waiting for seats to fill before it starts (02 §4). |
| Invitation | A lobby seat offered to an existing user who must accept it (per their `whoCanAddMe`), or to an email address with no account yet (06 §6). |
| Join link | A shareable link that lets signed-in people take open lobby seats (06 §6.8). |
| Past opponent | A user you've finished a game with (06 §6.9); can add you directly under the default setting. |
| Action | One move submitted by a player, defined by the game module. |
| `toAct` | The set of seats that may act now (02 §2.3). |
| Phase | A stretch of a game where several seats in `toAct` each act once, in any order (02 §2.3). |
| View | What one seat (or the public) may see of a game's state; the only way state reaches a client (02 §2). |
| Public record | A module's description of one transition, visible to every seat; used for history and notifications (02 §2.1). |
| Resource | External data a module needs, loaded and authorised by the framework, e.g. a dictionary (02 §2.1). |
| Out / eliminated | A seat no longer playing: eliminated by the rules, resigned or timed out (02 §4). |
| `endReason` | Module-defined reason a game ended, or a framework reason (`declined`, `cancelled`, `expired`). |
| OTP | One-time password emailed to the user for sign-in. |

Word game terms (games/words.md):

| Term | Meaning |
|------|---------|
| Ruleset | A versioned data file describing board, premium squares, tiles, rack size, bonuses and behaviour variants; chosen per game (words §8). |
| Dictionary | A versioned word list with metadata (language, licence); chosen per game (words §9). |
| Rack | The tiles a player currently holds (default 7). |
| Bag | Undrawn tiles. Its order is server-secret. |
| Bingo | Placing `rackSize` (default 7) tiles in a single play. Emptying a smaller late-game rack is not a bingo. |

Path game terms (games/paths.md):

| Term | Meaning |
|------|---------|
| Deck | Undrawn tiles; its order is server-secret. |
| Hand | The tiles a player holds (default 3), hidden from others. |
| Marker | A player's piece, sitting on a notch and facing an empty square. |
| Notch | One of 8 path endpoints on each square's edges, numbered 0–7 clockwise (paths §1). |
