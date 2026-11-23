// Gate fixture: the web app must not import the server.
import { server } from "../../../packages/server/src/index.ts";

export const app = server;
