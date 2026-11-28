import { expect, it } from "vitest";

import { client } from "./index.js";

// Until the client slice (10 §Pairs game) the package has no client and isn't installed.
it("has no client module yet", () => {
  expect(client).toBeNull();
});
