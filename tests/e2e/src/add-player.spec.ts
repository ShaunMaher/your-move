/**
 * Adding a link joiner to your players (alpha A19, 07 §1, 05 `add-player`, 06 §6.9): Ann makes a
 * words game with a join link, Bob joins through it, and both play a move before Ann resigns. A
 * link joiner is never paired automatically, so the finished screen asks Ann "Add Bob to your
 * players?" and says a rematch needs it; Rematch refused for want of it says so. Ann adds Bob, and
 * Rematch then starts the next game, which Bob opens from his own finished screen.
 */
import { ADD_PLAYER_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { FAR, isMyTurn, refocus } from "./game-steps.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";
import { pass } from "./words-player.js";

test("after a link game the creator adds the joiner to their players, and Rematch then works", async ({
  page: ann,
  friend: bob,
}) => {
  test.setTimeout(ADD_PLAYER_TEST_TIMEOUT_MS);
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, freshAddress(), "Bob");

  // Ann's game with a join link and no address; Bob joins through it and Ann starts.
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByRole("checkbox", { name: "Add a join link for the open seats" }).check();
  await ann.getByRole("button", { name: "Review" }).click();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  const first = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";
  expect(first).not.toBe("");
  const link = new URL(await ann.getByLabel(/Share this link/u).inputValue());
  await bob.goto(`/join${link.hash}`);
  await bob.getByRole("button", { name: "Join" }).click();
  await expect(bob.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await refocus(ann);
  await ann.getByRole("button", { name: "Start game" }).click(FAR);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);

  // Both act once (a pass is an action), then Ann resigns: the game is finished.
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
  const results = ann.getByRole("region", { name: "Final result" });
  await expect(results).toBeVisible(FAR);

  // Bob joined by link, so Ann is asked; and a rematch needs him added first.
  const question = results.getByRole("group", { name: "Add Bob to your players?" });
  await expect(question).toBeVisible();
  await expect(results.getByText("To rematch, first add Bob to your players.")).toBeVisible();
  await expectAccessible(ann);
  await question.getByRole("button", { name: "Not now" }).click();
  await expect(question).toHaveCount(0);
  await results.getByRole("button", { name: "Rematch" }).click();
  await expect(
    results.getByText("Add them to your players first, then press Rematch again."),
  ).toBeVisible(FAR);
  await expect(question).toBeVisible();

  // Ann says yes: the question gives way, and Rematch starts the next game with Bob in it.
  await question.getByRole("button", { name: "Add" }).click();
  await expect(results.getByText("Added Bob to your players.")).toBeVisible(FAR);
  await expect(question).toHaveCount(0);
  await expect(results.getByText(/To rematch, first add/u)).toHaveCount(0);
  await results.getByRole("button", { name: "Rematch" }).click();
  await expect(ann).not.toHaveURL(new RegExp(`/g/${first}$`, "u"), FAR);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  const next = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";
  expect(["", first]).not.toContain(next);

  // Bob was added straight in: his finished screen asks him nothing and leads to the rematch.
  await bob.goto(`/g/${first}`);
  const bobResults = bob.getByRole("region", { name: "Final result" });
  await expect(bobResults).toBeVisible(FAR);
  await expect(bobResults.getByRole("group")).toHaveCount(0);
  await bobResults.getByRole("button", { name: "Go to rematch" }).click(FAR);
  await expect(bob).toHaveURL(new RegExp(`/g/${next}$`, "u"));
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
});
