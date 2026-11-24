/**
 * The build manifest of a built-in dictionary (docs/spec/games/words.md §9.1, §9.3): its metadata,
 * the alphabet compatibility checks need, and the hash and size of its built word list. The build
 * writes one per dictionary and an index of all of them; the runtime parses that index at its
 * trust boundary before using it.
 */
import type { ResourceMeta } from "@your-move/sdk";
import { z } from "zod";

const SHA256 = /^[0-9a-f]{64}$/u;
const count = z.number().int().min(0);

/** Registry ids: the operator-id pattern of words §9.5, which can never start `u_` (uploads). */
export const DICTIONARY_ID = /^[a-z][a-z0-9-]{1,31}$/u;

/** A BCP 47-style language tag, matched exactly against a ruleset's (words §9.3). */
export const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

export const manifestSchema = z
  .object({
    id: z.string().regex(DICTIONARY_ID),
    version: z.number().int().min(1),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    language: z.string().regex(LANGUAGE),
    licence: z.string().min(1),
    sourceUrl: z.url({ protocol: /^https$/u }),
    /** SHA-256 of the unmodified upstream list (`source.txt`), as in `meta.json`. */
    sha256: z.string().regex(SHA256),
    /** Built-in lists are freely licensed, so clients may download them (words §9.5). */
    distribution: z.literal("public"),
    wordCount: count,
    /** The letters the list's words use, sorted (words §9.3). */
    alphabet: z.array(z.string().regex(/^[a-z]$/u)),
    /**
     * SHA-256 of the built word list (`words.txt`): checked when the list loads, and the basis of
     * its versioned, hashed URL (words §9.4).
     */
    wordsSha256: z.string().regex(SHA256),
    /** Length of the built word list in bytes (one byte per character: it is ASCII). */
    bytes: count,
    /** Upstream lines dropped by the build: too short or long, or not `a`–`z` only. */
    skipped: z.object({ length: count, characters: count }).strict(),
  })
  .strict();

export type DictionaryManifest = z.infer<typeof manifestSchema>;

/**
 * The build's index (`generated/index.json`): every built-in dictionary, and the global removals
 * (`removals-global.txt`, Q7), which the M6 upload and operator paths apply to their lists.
 */
const indexSchema = z
  .object({
    dictionaries: z.array(manifestSchema),
    globalRemovals: z.array(z.string().regex(/^[a-z]{2,15}$/u)),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = index.dictionaries.map((manifest) => manifest.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: "custom",
        message: "dictionary ids must be unique",
        path: ["dictionaries"],
      });
    }
  });

export type DictionaryIndex = z.infer<typeof indexSchema>;

/** Parses the build's index (storage is a trust boundary, 11 §2); throws if it is invalid. */
export function parseIndex(json: unknown): DictionaryIndex {
  return indexSchema.parse(json);
}

/** A built-in dictionary's metadata as the framework's resource catalog lists it (02 §2). */
export function toResourceMeta(manifest: DictionaryManifest): ResourceMeta {
  return {
    kind: "dictionary",
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    language: manifest.language,
    // A copy, frozen: the catalog is shared by every caller and must not alias the manifest.
    alphabet: Object.freeze([...manifest.alphabet]),
    distribution: manifest.distribution,
    source: "builtin",
  };
}
