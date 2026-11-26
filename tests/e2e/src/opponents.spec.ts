/**
 * Playing again with someone you've played (alpha A12, 07 §1.1, 06 §6.1): Ann and Bob finish a
 * words game in which both moved, then Ann starts the next one by picking Bob from "People you've
 * played". No address is typed and nothing is accepted: both land on an active board.
 */
import { REMATCH_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { createAndAccept, FAR, isMyTurn, refocus } from "./game-steps.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";
import { pass } from "./words-player.js";

test("a finished game's players start the next one from the list, straight onto the board", async ({
  page: ann,
  friend: bob,
}) => {
  test.setTimeout(REMATCH_TEST_TIMEOUT_MS);
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, bobAddress, "Bob");
  const first = await createAndAccept(ann, bob, bobAddress);
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  await refocus(ann);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);

  // Both act once (a pass is an action), so they become past opponents when the game ends.
  for (let moves = 0; moves < 2; moves++) {
    for (const page of [ann, bob]) await refocus(page);
    await expect.poll(async () => (await isMyTurn(ann)) || (await isMyTurn(bob)), FAR).toBe(true);
    const mover = (await isMyTurn(ann)) ? ann : bob;
    await pass(mover);
    await expect.poll(() => isMyTurn(mover), FAR).toBe(false);
  }
  await refocus(ann);
  await ann.getByRole("button", { name: "Menu" }).click();
  await ann.getByRole("button", { name: "Resign…" }).click();
  await ann.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
  await expect(ann.getByRole("heading", { level: 2, name: "Final result" })).toBeVisible(FAR);

  // Ann's next game: Bob is in her list, by name only, and picking him fills the seat.
  await ann.getByRole("link", { name: "Back to games" }).click();
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await ann.getByRole("button", { name: "Next" }).click();
  const played = ann.getByRole("group", { name: "People you've played" });
  await expect(played).toBeVisible();
  await expect(played.getByRole("checkbox")).toHaveCount(1);
  await played.getByRole("checkbox", { name: "Bob" }).check();
  await expect(ann.getByLabel("Their email address")).toHaveCount(0);
  await expectAccessible(ann);
  await ann.getByRole("button", { name: "Review" }).click();
  await expect(ann.getByText("Playing with Bob")).toBeVisible();
  await expect(ann.getByText(/starts as soon as you create it/u)).toBeVisible();
  await ann.getByRole("button", { name: "Create game" }).click();

  // No lobby and no invitation: the game is under way for both.
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  const second = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";
  expect(second).not.toBe("");
  expect(second).not.toBe(first);
  await bob.goto("/");
  await expect(bob.getByRole("region", { name: /Invitations/u })).toHaveCount(0);
  await bob
    .getByRole("link", { name: /Words with Ann/u })
    .first()
    .click();
  await expect(bob).toHaveURL(new RegExp(`/g/${second}$`, "u"));
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  await expectAccessible(bob);
});
