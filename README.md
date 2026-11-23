# Your Move

An ad-free, open-source platform for asynchronous, turn-based games with friends and family.
Play a move whenever you have a minute; your friends get a "your move" notification.
Mobile-first web app, installable to your phone's home screen.

- First games: a crossword-tile word game and a path-laying tile game for 2–8 players (good for
  kids and groups). More classic games later.
- Sign in with your email and a one-time code — no passwords.
- Start a game with anyone whose email you know, invite them if they're new, or share a join link.
- Self-host on Cloudflare Workers or with Docker.

**Status:** specification phase. See [`docs/spec/`](docs/spec/README.md).

The display name is configurable: deployments set it via `APP_NAME` (default "Your Move"), so a
fork or self-hosted instance can rebrand without code changes.

## Licence

BSD 2-Clause — see [LICENSE](LICENSE). The default word list is ENABLE (public domain).
