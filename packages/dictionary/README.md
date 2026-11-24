# @your-move/dictionary

The built-in word lists and how they are built and looked up: a framework resource provider
([docs/spec/games/words.md §9](../../docs/spec/games/words.md), 03 §10). Private workspace package.

## Layout

```
dictionaries/<id>/
  meta.json        { id, version, name, description, language, licence, sourceUrl, sha256 }
  source.txt       the upstream list, byte for byte; the build checks it against meta.json's sha256
  additions.txt    our additions, one word per line
  removals.txt     our removals, one word per line
removals-global.txt  words removed from every dictionary, built-in, operator or uploaded (Q7)
src/               the runtime: word-list format, lookup, manifests, DictionaryProvider (Web-standard)
src/builder/       the build (Node tooling): pnpm --filter @your-move/dictionary build
generated/         build output, never committed (see below)
```

`additions.txt`, `removals.txt` and `removals-global.txt` hold one lower-case `a`–`z` word of 2 to
15 letters per line, sorted, with no duplicates, comments or blank lines. An addition must not
already be in the source; a removal must be in it. Any change to these files or to the source is a
new dictionary version: bump `version` in `meta.json` and record the new list's hash in
`src/builder/builtin.test.ts`, which fails until you do.

## Licensing gate

Only public-domain or permissively licensed lists may be added, with the licence recorded in
`meta.json` and in the table below. The official tournament lists (the North American NWL/TWL
family and the Collins list) are not freely licensed and must never be added or bundled; players
with access to them use bring-your-own dictionaries (words §9.5).

| Id       | Name                                                              | Licence       | Source                                  | SHA-256 of `source.txt`                                            |
| -------- | ----------------------------------------------------------------- | ------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `enable` | ENABLE (Enhanced North American Benchmark LExicon), 172,820 words | Public domain | <https://norvig.com/ngrams/enable1.txt> | `61ba1392a5b6199dd161fae7b483cd262fb8a88c0d49bd2c9ecb6753e755697f` |

**ENABLE.** The list's own README states: "The word list is in plain ASCII format, unencrypted,
and is placed in the Public Domain for anyone to use as they see fit. It is non-proprietary, free,
and freely available for any legal use." Its archive index adds: "The ENABLE list has been placed
in the Public Domain. This means it is free and freely distributable." (Both from the ENABLE2K
distribution as kept in Debian's `scowl` source package,
<https://sources.debian.org/src/scowl/6-2/r/enable/>.) The `enable1.txt` copy used here was
fetched from Peter Norvig's site on 2026-11-24 and checked against an independent copy (the Google
Code archive of `dotnetperls-controls/enable1.txt`): the same 172,820 words in the same order,
differing only in line endings. It is committed unmodified.

## Removals (Q7)

`removals-global.txt` lists words whose main current sense is a slur against a group of people
(ethnic, national, religious, sexual-orientation or disability). Words whose main sense is
something else (a tool, a plant, a crack, an embankment) stay. The list is deliberately small;
change it by review like any other code. Every built-in dictionary also lists the same words in
its own `removals.txt` (a test checks it), and the build applies both.

## Build output

`pnpm build` runs the build, which writes `generated/` from scratch:

- `<id>/words.txt`: the compact word list: sorted, newline-terminated, lower-case `a`–`z` words of
  length 2 to 15. The server looks words up in it directly (binary search, no index);
- `<id>/words.txt.gz`, `<id>/words.txt.br`: the same, compressed, for clients (words §9.4);
- `<id>/manifest.json`: the metadata plus `sourceSha256`, `distribution` (`public`), `wordCount`,
  `alphabet` (the letters the words use, for ruleset compatibility, words §9.3), `sha256` and
  `bytes` of `words.txt`, and `skipped` (upstream lines dropped for their length or characters);
- `index.json`: every manifest; the runtime reads it through `parseIndex`.

Sizes of `enable` version 1: 168,493 words (4,272 upstream words longer than 15 letters dropped,
55 removed); `words.txt` 1,665,683 bytes, gzip 440,243 bytes, brotli 358,236 bytes. The committed
`source.txt` is 1,743,327 bytes. The build takes about 2.5 s, most of it brotli.

## Runtime

```ts
const provider = createDictionaryProvider({ index: parseIndex(json), loadText });
provider.catalog(); // ResourceMeta[] for the framework's resource catalog
const enable = await provider.load("enable"); // { id, version, has(word) }, cached per isolate
```

`loadText` is the runtime's choice (03 §10): a bundled text module on Workers while the bundle
budget allows, a static asset fetched once per isolate beyond it, a file read on Node. The
provider checks the loaded text's length against the manifest, shares one load between concurrent
first uses and retries after a failed load. `checkWordList` is the one-pass validation that
uploaded lists will need (M6).

## Measurements (10 M1, 03 §10)

Measured 2026-11-24 on an AMD Ryzen 7 PRO 7840HS laptop, Node 26.13.1 and the workerd bundled with
wrangler 4.165.0, against `enable` version 1.

| What                                                                              | Result                                                                                                                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lookup CPU (Node, 200,000 lookups × 5, half present, half one-letter near misses) | median 0.99 µs per lookup (0.91–1.01)                                                                                                                                             |
| Single lookup wall time                                                           | p50 0.93 µs, p99 2.0 µs                                                                                                                                                           |
| A play's lookups (at most 8 words: the main word and one cross-word per tile)     | under 16 µs at p99                                                                                                                                                                |
| Loading the list (read + string, Node)                                            | 1.7 ms CPU; resident memory +2.7 MB (well under 25 MB)                                                                                                                            |
| Worker bundle with `words.txt` as a text module (`wrangler deploy --dry-run`)     | 1,628 KiB, 431 KiB gzipped                                                                                                                                                        |
| Worker startup (`wrangler check startup`, three runs each)                        | profile window 17.5–18.3 ms with the list, 17.8–18.9 ms without; sampled active time 0–8.7 ms with, 0 ms without (one or two samples per run, so below the profiler's resolution) |

So bundling ENABLE adds no startup cost measurable locally, and a lookup costs about a microsecond,
far inside the Workers Free CPU limit of 10 ms per request. Cloudflare reports the real startup
time on the first deployment (10 §First Workers deployment); record it there.

The lookup numbers come from a throwaway script outside the repository that imports
`src/lookup.ts` and times `has()` with `process.cpuUsage()` over the built list; the startup
numbers from two minimal Workers, one importing `generated/enable/words.txt` as a text module and
calling `createWordList` at the top level, the other identical without the list.
