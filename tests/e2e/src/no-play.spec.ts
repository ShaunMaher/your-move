/**
 * The no-play hint (A14) and the local preview (A16) in the real app (alpha A14, words §10.8, 02 §3): the shell downloads the game's
 * public word list, checks its hash, hands it to the board, and the board's search proves the
 * rack can't play. A random deal almost always can, so the test rewrites only the rack in Ann's
 * own copy of her view (C C V V Q X Z, which forms no word in the built-in list) as her page
 * receives it; the server, the list and everything else are real. Ann's page runs without a
 * service worker, because Playwright can't route requests a worker controls; the word-list cache
 * doesn't need one. The same note covers counting requests: with a worker in charge the page's
 * requests aren't all visible to Playwright, so the preview count is only meaningful here.
 */
import { NO_PLAY_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { createAndAccept, FAR, refocus } from "./game-steps.js";
import { freshAddress, signUp } from "./helpers.js";
import { loadWordList, takeTurn } from "./words-player.js";

const NO_PLAY_RACK = ["c", "c", "q", "v", "v", "x", "z"];

test.use({ serviceWorkers: "block" });

test("the board says when the rack can't make a word, and suggests a swap", async ({
  page: ann,
  friend: bob,
}) => {
  test.setTimeout(NO_PLAY_TEST_TIMEOUT_MS);
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, bobAddress, "Bob");
  const gameId = await createAndAccept(ann, bob, bobAddress);

  // Ann created the game, so she moves first, on an empty board with a full bag.
  await ann.route(new RegExp(`/api/v1/games/${gameId}$`, "u"), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { view: { yourRack: string[] } | null };
    if (body.view !== null) body.view.yourRack = NO_PLAY_RACK;
    return route.fulfill({ response, json: body });
  });
  await refocus(ann);
  const board = ann.getByRole("region", { name: "Words board" });
  await expect(board).toBeVisible(FAR);
  await expect(board.getByText("Your turn")).toBeVisible(FAR);

  await expect(
    board.getByText("No word can be played with your tiles. Try swapping some."),
  ).toBeVisible(FAR);
  // A hint only: swapping and passing are offered as usual.
  await expect(board.getByRole("button", { name: "Swap" })).toBeEnabled();
  await expect(board.getByRole("button", { name: "Pass" })).toBeEnabled();
  // The list came from the game's own served file, kept in the word-list cache.
  expect(
    await ann.evaluate(async () => (await (await caches.open("dictionaries-v1")).keys()).length),
  ).toBe(1);
});

test("once the word list has loaded, placing tiles asks the server for no preview", async ({
  page: ann,
  friend: bob,
}) => {
  test.setTimeout(NO_PLAY_TEST_TIMEOUT_MS);
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, bobAddress, "Bob");
  const gameId = await createAndAccept(ann, bob, bobAddress);
  await refocus(ann);
  const board = ann.getByRole("region", { name: "Words board" });
  await expect(board.getByText("Your turn")).toBeVisible(FAR);
  // The board has the list once the shell has put it in the word-list cache.
  await expect
    .poll(
      async () =>
        ann.evaluate(async () =>
          (await caches.open("dictionaries-v1")).keys().then((k) => k.length),
        ),
      FAR,
    )
    .toBe(1);

  const previews: string[] = [];
  ann.on("request", (request) => {
    if (/\/api\/v1\/games\/[^/]+\/preview$/u.test(request.url())) previews.push(request.url());
  });
  // takeTurn places the tiles, waits for "All words are in the word list." and plays.
  const played = await takeTurn(ann, await loadWordList(ann, gameId));
  expect(played).toBe(true);
  expect(previews).toEqual([]);
});
