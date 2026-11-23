/**
 * `@your-move/sdk/schema`: the Zod instance game packages build their option, action, view and
 * config schemas with, so an engine needs no Zod dependency of its own (game packages have no
 * `dependencies`; Zod is a peer of the SDK).
 *
 * @packageDocumentation
 */
export { z } from "zod";
