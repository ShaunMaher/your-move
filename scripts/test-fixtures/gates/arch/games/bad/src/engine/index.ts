// Gate fixture: an engine importing node:fs must fail `pnpm lint:arch` (10 M0).
import { readFileSync } from "node:fs";

export const engines = { 1: readFileSync };
