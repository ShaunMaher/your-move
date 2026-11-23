# 01 — Product

## 1. Problem

The popular commercial crossword-tile games are smothered in ads, upsells and dark patterns. We
want the same relaxed, asynchronous "play a move when you have a minute" experience with friends
and family, with none of that — and not just for word games.

The product is a **platform for asynchronous, turn-based multiplayer games** (02). The word game is
the first game; a path-laying tile game for 2–8 players (good for kids and groups) is the second.

## 2. Goals

1. A game framework for asynchronous, turn-based games with 2–8 players, hidden information,
   elimination and rankings, with games as plug-in modules (02). First modules: `words` (2 players)
   and `paths` (2–8 players).
2. Excellent on a phone, in portrait, one-handed. Installable to the iPhone home screen (PWA).
3. Zero ads, zero tracking, zero third-party analytics.
4. Frictionless sign-in: email → one-time code → done. First sign-in asks for a display name and
   an age confirmation.
5. Start a game with anyone whose email address you know; invite them by email if they're new.
6. Self-hostable: one codebase that deploys either to Cloudflare Workers or as a Docker container.
7. Open source under BSD-2-Clause.
8. Modular rules: the game creator picks a ruleset and a dictionary per game. Ship rulesets
   modelled on the two best-known games first, then add our own variants and more dictionaries.

## 3. Non-goals (v1)

- Native apps, app-store distribution.
- Public matchmaking / playing strangers, leaderboards, ELO.
- Chat (planned later, see roadmap).
- Solo play vs. a computer opponent (planned later).
- Payments of any kind.
- Social-login providers (Google/Apple). Email OTP only.
- Horizontal scaling of the Docker deployment (single instance is fine; see 03).
- Using any trademarked product name, logo, board artwork or trade dress from existing games.

## 4. Users

- **Player**: someone aged `MIN_AGE`+ (default 13) with a phone who wants to play games with
  friends and family. Younger children play through a parent's or carer's account (Q20).
- **Operator**: the person who deploys an instance (Cloudflare account or a Docker host). In
  practice the owner of this repo, plus anyone else who forks it.

## 5. User stories (v1)

Accounts
- U1. As a new visitor I enter my email, receive a code, enter it, choose a display name, and land
  on my game list.
- U2. As a returning player I enter my email and code and land on my game list. On the home-screen
  app I stay signed in for months without re-entering a code.
- U3. As a player I can change my display name.
- U4. As a player I can sign out (this device) and sign out everywhere.
- U5. As a player I can delete my account and my personal data.

Framework
- F1. As a player I pick which game to start, set its options and turn timeout, and choose players
  by email, from past opponents, or by sharing a join link.
- F2. Games wait in a lobby until every seat is filled; the creator can start early once the
  minimum have joined, and can remove someone from the lobby. A game with a join link waits for the
  creator to press Start.
- F3. My game list shows all my games of every type: *Your turn*, *Invitations*, *Waiting*,
  *Finished*.
- F4. I choose whether people I've finished a game with can add me to games straight away, or
  nobody can. Everyone else sends me an invitation that I accept or decline; for an invitation my
  lock screen only says "You have a new game invitation", never who sent it (if I've turned email
  nudges on, the invitation email does name them). A past opponent adding me shows their name.
- F5. Adding someone by email never tells me whether they already have an account: the app shows
  the address back so I can check it, and the seat shows that address while it's waiting. If I
  remove it or it's declined, it shows just "Removed" or "Declined", the same for every seat.

Words (games/words.md)
- G1. As a player I start a new game by entering an opponent's email address and choosing a
  ruleset (MVP: "Classic" or "Casual", see words §8.3) and a dictionary (MVP: ENABLE). My last
  choices are remembered.
- G2. If that email belongs to an existing player, they get an invitation and the game starts when
  they accept. If I pick a past opponent from my list instead and they allow it (F4), the game
  starts at once and they're notified.
- G3. If nobody plays with that address yet, they get an invite email; the game waits in the lobby,
  and when they sign up with that address the invitation is waiting for them. Either way I see the
  same "Game created — we'll let them know" (F5).
- G4. I can re-challenge a past opponent from a list (no email retyping).
- G5. I see my word games in the shared game list (F3).
- G6. In a game I can drag tiles from my rack to the board, rearrange/shuffle my rack, recall tiles,
  see a live score preview and validity indicator, and submit.
- G7. I can swap tiles (if enough remain in the bag), pass, or resign.
- G8. I can see the move history with words and scores, and how many tiles remain in the bag.
- G9. When my opponent moves while I have the app open, the board updates without a reload.
- G10. I get a notification when it's my turn (web push on supported devices; see 07/09).
- G11. An invitee or opponent can decline a new game before making a move, and isn't penalised:
  in a 2-player game nobody wins or loses; in a bigger game they simply leave without a rank.
- G12. I can block a player so they can't start games with me.
- G13. If I have access to another word list (e.g. a tournament list I'm licensed for), I can upload
  it and use it for games I create. The app tells me where official lists can be obtained but never
  provides them (words §9.5).

Paths (games/paths.md)
- P1. As a player I can start a path game for 2–8 players and share a join link in a group chat.
- P2. On my turn I rotate a tile from my hand and see exactly where every affected marker would go
  before placing it.
- P3. I see the movement animated when anyone plays, and who's been eliminated.

## 6. Quality bar

- First meaningful paint on a mid-range phone over 4G: < 2 s. Subsequent launches (service worker
  cache): < 1 s to the game list shell.
- Submitting a move: server round-trip p95 < 500 ms on Cloudflare for players on the same
  continent as the D1 primary (see 03 §11).
- Works on iOS Safari 16.4+ (home-screen web app), current Chrome/Firefox/Safari on Android and
  desktop.
- Accessible: tiles and squares have text labels, sufficient contrast, respects reduced motion.
