/**
 * `@your-move/sdk/client`: the client module contract and React helpers for game clients
 * (docs/spec/02-game-framework.md §3). Engines and manifests must never import this entry point
 * (02 §7.5).
 *
 * @packageDocumentation
 */
import { createElement, Fragment, type ComponentType, type ReactElement } from "react";

import type { SubmitResult, GameEnvelope } from "./api.js";
import type { GameError, Text } from "./contract.js";
import { formatText } from "./text.js";

/**
 * A public word list as the shell hands it to a board (02 §3, words §9.4): lookups over the list's
 * sorted text, which the shell downloaded from the game's own resource and checked against the
 * hash in its URL. Only a resource marked `distribution: "public"` is ever handed over.
 *
 * Words are lower-case `a`–`z` only: the shell hands over only a list that passes the word-list
 * check, and `follows` answers only `a`–`z`. A board given a list it can't use, such as one with
 * any other letter, must treat it as no list.
 *
 * @public
 */
export interface PublicWordList {
  /** The dictionary's id, as in the game's options and view. */
  readonly id: string;
  /** The version of the list's current build (words §9.4: informational). */
  readonly version: number;
  /** Whether `word` is in the list. */
  has(word: string): boolean;
  /** The letters `a`–`z` that follow `prefix` in some word of the list, as a bit mask: bit 0 is `a`. */
  follows(prefix: string): number;
}

/**
 * Public resources of the game, loaded by the shell for its board (02 §3). Every entry is
 * optional: a board works without them. Nothing in here is secret.
 *
 * @public
 */
export interface BoardResources {
  /** The game's word list, only when it is public and the shell has it loaded. */
  readonly dictionary?: PublicWordList;
}

/**
 * Props of a client module's board (02 §3).
 *
 * @public
 */
export interface BoardProps<Action, View, PreviewResult> {
  readonly game: GameEnvelope;
  /** The viewer's view; its shape follows `game.gameVersion`. */
  readonly view: View;
  /** Submits an action through the shell; the module never talks to the API itself. */
  readonly submit: (action: Action) => Promise<SubmitResult>;
  /** A non-authoritative preview: local when possible, else from the server. */
  readonly preview: (action: Action) => Promise<PreviewResult | GameError>;
  /**
   * The game's public resources once the shell has loaded them; absent until then, and always
   * when there are none. The same object for as long as they don't change; games with the same
   * list get the same list object.
   */
  readonly resources?: BoardResources;
}

/**
 * Props of a client module's options form (02 §3).
 *
 * @public
 */
export interface OptionsFormProps {
  /** This module's part of `GET /api/v1/catalog`. */
  readonly catalog: unknown;
  /** The unresolved options input. */
  readonly value: unknown;
  readonly onChange: (input: unknown) => void;
}

/**
 * Props of a client module's rules sheet (02 §3).
 *
 * @public
 */
export interface RulesSheetProps<Options> {
  readonly options: Options;
  readonly gameVersion: number;
}

/**
 * Props of a client module's history item (02 §3).
 *
 * @public
 */
export interface HistoryItemProps {
  readonly record: unknown;
  /** The entry's stored `describe` text: what to show for a record the module can't render. */
  readonly describe: Text;
  readonly gameVersion: number;
  /** Display names by seat, as the shell renders them. */
  readonly names: readonly string[];
}

/**
 * A package's `/client` export (02 §3): the board and the module's own UI pieces. Name, icon and
 * rules text live in the manifest.
 *
 * @public
 */
export interface GameClientModule<
  Options = unknown,
  Action = unknown,
  View = unknown,
  PreviewResult = unknown,
> {
  readonly type: string;
  /** Every server rules version whose views and records it can render. */
  readonly versions: readonly number[];
  readonly OptionsForm: ComponentType<OptionsFormProps>;
  readonly Board: ComponentType<BoardProps<Action, View, PreviewResult>>;
  readonly RulesSheet: ComponentType<RulesSheetProps<Options>>;
  readonly HistoryItem: ComponentType<HistoryItemProps>;
}

// The main entry's helper, re-exported so client modules keep importing it from here.
export { formatText } from "./text.js";

/**
 * Renders a `Text` as React text, with the names filled in.
 *
 * @public
 */
export function TextView(props: {
  readonly text: Text;
  readonly names: readonly string[];
}): ReactElement {
  return createElement(Fragment, null, formatText(props.text, props.names));
}
