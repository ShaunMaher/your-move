// Gate fixture: core code outside src/db/ must not reach the schema (03 §4).
import { users } from "../db/schema.js";

export const table = users;
