import { GAME_TYPE_PATTERN } from "@your-move/sdk";
import { z } from "@your-move/sdk/schema";
import { score } from "./rules.js";

export const engines = { "1": { pattern: GAME_TYPE_PATTERN, schema: z, score } };
