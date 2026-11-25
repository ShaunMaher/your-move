/**
 * Dictionaries as a framework resource (docs/spec/03-architecture.md §10, games/words.md §9): the
 * compact word-list format, lookup, the built-in dictionaries' manifests and `DictionaryProvider`.
 * Web-standard APIs only, so the server core can use it on every runtime. The build that turns
 * `dictionaries/<id>/` into word lists is Node tooling in `src/builder/`, run by this package's
 * `build` script.
 */
export {
  checkWordList,
  formatWordList,
  type CheckOptions,
  isWord,
  MAX_WORD_LENGTH,
  MIN_WORD_LENGTH,
  type WordListCheck,
  type WordListProblem,
} from "./format.js";
export { createWordList, hasWord, WordListFormatError, type WordList } from "./lookup.js";
export {
  manifestSchema,
  parseIndex,
  servedFileName,
  servedPath,
  toResourceMeta,
  type DictionaryIndex,
  type DictionaryManifest,
} from "./manifest.js";
export {
  createDictionaryProvider,
  DictionaryMismatchError,
  type DictionaryProvider,
  type DictionaryProviderOptions,
} from "./provider.js";
