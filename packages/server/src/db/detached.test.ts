import { describe, expect, it } from "vitest";

import { DetachedStorageError, detachedRepositories } from "./detached.js";

describe("detachedRepositories", () => {
  it("rejects every call, naming the operation", async () => {
    const repos = detachedRepositories();
    await expect(repos.users.findById("u")).rejects.toThrow(DetachedStorageError);
    await expect(repos.games.applyTransition("g", 0, { game: { updatedAt: 0 } })).rejects.toThrow(
      "games.applyTransition: this app has no database",
    );
    for (const repo of Object.values(repos) as Record<string, () => Promise<unknown>>[]) {
      for (const method of Object.values(repo)) {
        await expect(method()).rejects.toThrow(DetachedStorageError);
      }
    }
  });
});
