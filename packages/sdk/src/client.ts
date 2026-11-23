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
  submit(action: Action): Promise<SubmitResult>;
  /** A non-authoritative preview: local when possible, else from the server. */
  preview(action: Action): Promise<PreviewResult | GameError>;
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
  onChange(input: unknown): void;
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

/**
 * Fills a `Text`'s seat placeholders with names (02 §5). A seat without a name renders as
 * "Seat n" (numbered from 1).
 *
 * @public
 */
export function formatText(text: Text, names: readonly string[]): string {
  return text
    .map((part) =>
      typeof part === "string" ? part : (names[part.seat] ?? `Seat ${String(part.seat + 1)}`),
    )
    .join("");
}

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
