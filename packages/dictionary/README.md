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
src/builder/       the build and the benchmark (Node tooling)
generated/         build output, never committed (see below)
```

`additions.txt`, `removals.txt` and `removals-global.txt` hold one lower-case `a`–`z` word of 2 to
15 letters per line, sorted, with no duplicates, comments or blank lines. An addition must not
already be in the source; a removal must be in it. Each built-in `removals.txt` lists every global
removal its source contains (a test checks it). Any change to these files or to the source is a
new dictionary version: bump `version` in `meta.json` and add the new list's hash to `RELEASED` in
`src/builder/builtin.test.ts`, which fails until you do. Never edit an existing `RELEASED` entry.

A change to a `source.txt` must say in its merge request where the new list came from (its URL),
and the reviewer re-fetches it from there and re-hashes it before approving. The files above are
owner-reviewed (CODEOWNERS).

## Licensing gate

Only public-domain or permissively licensed lists may be added, with the licence recorded in
`meta.json` and in the table below. The official tournament lists (the North American NWL/TWL
family and the Collins list) are not freely licensed and must never be added or bundled; players
with access to them use bring-your-own dictionaries (words §9.5).

| Id       | Name                                                              | Licence       | Source                                      | SHA-256 of `source.txt`                                            |
| -------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `enable` | ENABLE (Enhanced North American Benchmark LExicon), 172,820 words | Public domain | <https://www.norvig.com/ngrams/enable1.txt> | `61ba1392a5b6199dd161fae7b483cd262fb8a88c0d49bd2c9ecb6753e755697f` |

**ENABLE.** The list's own README states: "The word list is in plain ASCII format, unencrypted,
and is placed in the Public Domain for anyone to use as they see fit. It is non-proprietary, free,
and freely available for any legal use." Its archive index adds: "The ENABLE list has been placed
in the Public Domain. This means it is free and freely distributable." (Both from the ENABLE2K
distribution as kept in Debian's `scowl` source package,
<https://sources.debian.org/src/scowl/6-2/r/enable/>.) The `enable1.txt` copy used here was
fetched from Peter Norvig's site on 2026-11-24 (`https://norvig.com/ngrams/enable1.txt`, which
redirects to the URL above) and checked against an independent copy (the Google Code archive of
`dotnetperls-controls/enable1.txt`): the same 172,820 words in the same order, differing only in
line endings. It is committed unmodified.

## Removals (Q7)

`removals-global.txt` lists words whose main current sense is a slur against a group of people
(ethnic, national, religious, sexual-orientation or disability), with their inflected forms. Words
whose main sense is something else (a tool, a plant, a crack, an embankment) stay. The list is
deliberately small; change it by review like any other code. The build applies both the global
list and each dictionary's own `removals.txt`.

The borderline set added in the M1b review (squaw, sambo, greaseball, bohunk, kaffir, kafir,
coolie, shylock, mongoloid, gyp, faggotry and spick, with their inflected forms, and faggoted,
faggoting and faggotings) was removed by owner decision.

## Build output

`pnpm build` runs the build, which writes `generated/` from scratch:

- `<id>/words.txt`: the compact word list: sorted, newline-terminated, lower-case `a`–`z` words of
  length 2 to 15. The server looks words up in it directly (binary search, no index);
- `<id>/words.txt.gz`, `<id>/words.txt.br`: the same, compressed, for clients (words §9.4);
- `<id>/manifest.json`: the `meta.json` fields (`sha256` is still the source's hash) plus
  `distribution` (`public`), `wordCount`, `alphabet` (the letters the words use, for ruleset
  compatibility, words §9.3), `wordsSha256` and `bytes` of `words.txt`, and `skipped` (upstream
  lines dropped for their length or characters);
- `index.json`: every manifest and the global removals, which the M6 upload and operator paths
  apply to their lists; the runtime reads it through `parseIndex`.

Tests elsewhere in the workspace that need a real list (the words engine's property tests) build
one in memory, writing nothing, with `buildBuiltin(id)` from `@your-move/dictionary/builder`.

Sizes of `enable` version 2: 168,462 words (4,272 upstream words longer than 15 letters dropped,
86 removed); `words.txt` 1,665,430 bytes, gzip 440,177 bytes, brotli 358,284 bytes. The committed
`source.txt` is 1,743,327 bytes. The build takes about 2.5 s, most of it brotli.

## Runtime

```ts
const provider = createDictionaryProvider({ index: parseIndex(json), loadText });
provider.catalog(); // ResourceMeta[] for the framework's resource catalog
const enable = await provider.load("enable"); // { id, version, has(word) }, cached per isolate
```

`loadText` is the runtime's choice (03 §10): a bundled text module on Workers while the bundle
budget allows, a static asset fetched once per isolate beyond it, a file read on Node. The provider
checks the loaded text's size and SHA-256 against the manifest before its first use, shares one
load between concurrent first uses and retries after a failed load. `checkWordList` is the
one-pass format validation that uploaded lists will need (M6); it doesn't apply removals.

## Measurements (10 M1, 03 §10)

Measured 2026-11-24 on an AMD Ryzen 7 PRO 7840HS laptop with Node 26.13.1 and the workerd bundled
with wrangler 4.165.0. Load and lookup numbers are for `enable` version 2, from the committed
benchmark: `pnpm --filter @your-move/dictionary bench` (`src/builder/bench.ts`, CPU time from
`process.cpuUsage()`). The Worker numbers were taken on version 1, which differs by 253 bytes.

| What                                                                                         | Result                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lookup CPU (200,000 lookups × 5, half present, half absent one-letter near misses)           | median 0.85 µs per lookup (two runs)                                                                                                                  |
| A play's lookups (derived: 8 words, the main word and one cross-word per tile, × the median) | about 7 µs                                                                                                                                            |
| Loading the list, once per process or isolate (read, plus the SHA-256 check)                 | 3.9–4.6 ms CPU, of which the SHA-256 check is 2.6–2.7 ms                                                                                              |
| Resident memory added by the list                                                            | 3.3 MB (the limit is 25 MB)                                                                                                                           |
| Worker bundle with `words.txt` as a text module (`wrangler deploy --dry-run`)                | 1,628 KiB, 431 KiB gzipped                                                                                                                            |
| Worker startup (`wrangler check startup`, three runs each, with and without the list)        | 0–8.7 ms sampled active time with the list, 0 ms without, within the profiler's resolution (one or two samples per run); profile windows 17.5–18.9 ms |

So bundling ENABLE adds no startup cost the local profiler can resolve, a lookup costs under a
microsecond, and the one-time check costs a few milliseconds in the first request that needs the
dictionary, all inside the Workers Free CPU limit of 10 ms per request. Cloudflare reports the
real startup time on the first deployment (10 §First Workers deployment); record it there.

The startup numbers come from two minimal Workers outside the repository, one importing
`generated/enable/words.txt` as a text module and calling `createWordList` at the top level, the
other identical without the list.
