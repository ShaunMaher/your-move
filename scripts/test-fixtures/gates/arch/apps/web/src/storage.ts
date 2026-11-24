// Gate fixture: only the storage adapters may use Drizzle (03 §4).
import { sql } from "drizzle-orm";

export const query = sql;
