import { SERVER_PATHS } from "@your-move/shared/server-paths";

/**
 * Build-time constants for the app (Vite's `define`, for the build and for the tests): the app's
 * source may not import the server's packages (11 §5), so the build hands it what it needs.
 */
export const defines = {
  /** Paths the server handles (`@your-move/shared/server-paths`); never a remembered return path. */
  __SERVER_PATHS__: JSON.stringify(SERVER_PATHS),
};
