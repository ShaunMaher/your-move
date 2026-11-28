/**
 * The paths engine: one `GameDefinition` per supported rules version
 * (docs/spec/02-game-framework.md §7.1, §7.4, docs/spec/games/paths.md). A new rules version is
 * added here alongside the old ones, which stay exported while any live game may use them. The
 * client also reaches the geometry, the tile set and the movement rules through this entry point,
 * so its local preview is computed by the same code as the server (paths §3).
 */
import type { GameEngines } from "@your-move/sdk";

import { pathsV1 } from "./definition.js";

export const engines = { 1: pathsV1 } satisfies GameEngines;

export {
  across,
  edgeNotch,
  edgeNotchCount,
  NOTCHES,
  samePosition,
  type NotchPosition,
} from "./geometry.js";
export { selfElimination, type SelfElimination } from "./rules.js";
export { livePosition, movement, type Board, type Movement, type Square } from "./movement.js";
export {
  actionSchema,
  catalogSchema,
  recordSchema,
  viewSchema,
  type Action,
  type Catalog,
  type EndReason,
  type Marker,
  type Move,
  type Options,
  type Out,
  type OutReason,
  type Phase,
  type Placed,
  type Position,
  type PublicRecord,
  type View,
} from "./schemas.js";
export { partner, ROTATIONS, TILE_COUNT, TILES, type Pair, type Tile } from "./tiles.js";
