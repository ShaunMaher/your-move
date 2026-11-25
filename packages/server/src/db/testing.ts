/**
 * `@your-move/server/testing`: what the runtime adapters' tests need from the core — the shared
 * repository contract suite, the transition race suite and replay, and the schema, so a test can
 * check that the committed migrations still produce exactly the schema's tables. Never part of a
 * runtime build.
 */
export { repositoryContract, type ContractTarget } from "./repository-contract.js";
export { gameRaceContract } from "../games/race-contract.js";
export { replayState } from "../games/replay.js";
export { createSession } from "../auth/session.js";
export * as schema from "./schema.js";
