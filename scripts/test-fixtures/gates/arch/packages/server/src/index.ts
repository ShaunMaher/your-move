// Gate fixture: the core must not use Node built-ins.
import { createServer } from "node:http";

export const server = createServer;
