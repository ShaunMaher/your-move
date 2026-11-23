# 1. API first, with Durable Objects only as a realtime channel

Status: accepted (2026-11-23)

## Context

The product runs on two targets: Cloudflare Workers (D1 and Durable Objects) and Docker (Node and
SQLite). It also has more than one client: the web app, people's own AI agents through an MCP
server, and anything else a player or operator writes. On Cloudflare, a per-game Durable Object
would give free serialisation of moves, and it is tempting to keep game state there.

## Decision

- **Every capability is an endpoint of the public, versioned HTTP API** (`/api/v1`, 05), defined
  by one Zod schema per route. The schemas generate the OpenAPI document and the typed
  `@your-move/api-client`, which the web app uses like any other client. There are no private
  endpoints for the web app; operator tasks live in a separate Admin API.
- **SQL is the only state of record** on both targets (D1 and SQLite speak the same dialect).
  Moves are serialised by a `version` + `write_token` guarded transition (03 §5.2), which behaves
  the same on both drivers.
- **Durable Objects are only a realtime channel**: one `UserChannel` per user holds that user's
  WebSockets and relays "something changed" invalidations. It stores nothing a client couldn't
  lose; every read and write still goes through the HTTP API.

## Consequences

- One API contract and one contract-test suite run against both runtime builds; the Docker target,
  which has no Durable Objects, behaves identically.
- Secrets never travel over the socket path: clients refetch views through the API.
- Breaking changes are visible in review: CI compares the OpenAPI document with the target
  branch's (`oasdiff breaking`) and fails on a breaking change within v1.
- Contention on a hot game costs a retry (`409 STALE_GAME`) instead of queueing in a Durable
  Object. If contention or latency becomes a problem, moving authoritative game state into a
  per-game Durable Object is a contained change behind the game repository interface (03 §5.1).

## Alternatives considered

- **Game state in per-game Durable Objects** — serialisation for free, but two sources of truth
  (D1 is still needed for users and game lists) and a completely different storage path for
  Docker.
- **A private API for the web app** — faster to build, but every other client would lag behind it,
  and the AI-player and MCP features need the same capabilities anyway.
