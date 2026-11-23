/**
 * The example engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, §7.4, §7.6). A new rules version is added here alongside
 * the old ones, which stay exported while any live game may use them.
 */
import type { GameEngines } from "@your-move/sdk";

import { exampleV1 } from "./definition.js";

export const engines = { 1: exampleV1 } satisfies GameEngines;

export {
  actionSchema,
  catalogSchema,
  DECK_SIZE,
  previewSchema,
  recordSchema,
  viewSchema,
  type Action,
  type Catalog,
  type EndReason,
  type LastRound,
  type Options,
  type PreviewResult,
  type PublicRecord,
  type View,
} from "./schemas.js";
