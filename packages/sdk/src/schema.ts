/**
 * `@your-move/sdk/schema`: the Zod that game packages build their option, action, view and config
 * schemas with. Engines and manifests reach Zod only through this entry point, never by importing
 * `zod` directly (02 §7.1.1, §7.5); `zod` is a peer dependency of both the SDK and the game
 * package, so the instance supplies the one copy everything uses.
 *
 * @packageDocumentation
 */
export { z } from "zod";
