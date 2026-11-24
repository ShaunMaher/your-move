/**
 * `@your-move/server/testing`: what the runtime adapters' tests need from the core's storage
 * layer — the shared repository contract suite, and the schema, so a test can check that the
 * committed migrations still produce exactly the schema's tables. Never part of a runtime build.
 */
export { repositoryContract, type ContractTarget } from "./repository-contract.js";
export * as schema from "./schema.js";
