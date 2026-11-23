/** The app's one API client (03 §1 principle 6): same origin, so no base URL is needed. */
import { createApiClient } from "@your-move/api-client";

export const api = createApiClient({ baseUrl: globalThis.location.origin });
