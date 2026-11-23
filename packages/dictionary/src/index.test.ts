import { expect, it } from "vitest";

import { PLANNED } from "./index.js";

it("is a placeholder until its milestone", () => {
  expect(PLANNED).toBe(true);
});
