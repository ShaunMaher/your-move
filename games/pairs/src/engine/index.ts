/**
 * The pairs engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, §7.4, docs/spec/games/pairs.md). A new rules version is
 * added here alongside the old ones, which stay exported while any live game may use them. The
 * client reaches the grids, the faces and the view's types through this entry point.
 */
import type { GameEngines } from "@your-move/sdk";

import { pairsV1 } from "./definition.js";

export const engines = { 1: pairsV1 } satisfies GameEngines;

export { FACES, type FaceName } from "./faces.js";
export {
  actionSchema,
  catalogSchema,
  DEFAULT_GRID,
  FACE_COUNT,
  GRID_IDS,
  GRIDS,
  recordSchema,
  viewSchema,
  type Action,
  type Card,
  type CardState,
  type Catalog,
  type EndReason,
  type Grid,
  type GridId,
  type Options,
  type OutReason,
  type PublicRecord,
  type View,
} from "./schemas.js";
