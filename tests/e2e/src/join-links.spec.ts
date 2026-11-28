/**
 * A join link (alpha A18, 06 §6.8, 07 §1, 08 T24): Ann creates a words game with "Add a join link
 * for the open seats" and no address, and gets the link once in her lobby. Bob opens it signed out:
 * the token leaves the address bar at once, he signs up on the way, lands back on the link's page
 * and joins only when he taps Join. The game waits until Ann presses Start, then both are on the
 * board.
 */
import { JOIN_LINK_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { FAR, refocus } from "./game-steps.js";
import { codeFrom, expectAccessible, freshAddress, requestCodeFor, signUp } from "./helpers.js";

test("a join link brings a new player into the lobby, and the game starts when its creator starts it", async ({
  page: ann,
  friend: bob,
}) => {
  test.setTimeout(JOIN_LINK_TEST_TIMEOUT_MS);
  await signUp(ann, freshAddress(), "Ann");
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByRole("checkbox", { name: "Add a join link for the open seats" }).check();
  await ann.getByRole("button", { name: "Review" }).click();
  await expect(ann.getByText(/You'll get a join link for the open seats/u)).toBeVisible();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  const field = ann.getByLabel(/Share this link/u);
  await expect(field).toBeVisible();
  const link = new URL(await field.inputValue());
  const token = link.hash.slice(1);
  expect(link.pathname).toBe("/join");
  expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  await expect(ann.getByText(/^Link active until/u)).toBeVisible();
  await expectAccessible(ann);

  // Bob, signed out, opens the link: the token is gone from the address bar straight away.
  await bob.goto(`/join#${token}`);
  await expect(bob.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(bob.url()).not.toContain(token);
  const bobAddress = freshAddress();
  await requestCodeFor(bob, bobAddress);
  await bob.getByLabel("Sign-in code").fill(await codeFrom(bob.request, bobAddress, 0));
  await bob.getByRole("button", { name: "Sign in", exact: true }).click();
  await bob.getByLabel("Display name").fill("Bob");
  await bob.getByRole("button", { name: "Continue" }).click();

  // Back on the link's page, nothing joined until he taps Join.
  await expect(bob.getByRole("heading", { level: 1 })).toHaveText("Join Words");
  expect(new URL(bob.url()).pathname).toBe("/join");
  expect(bob.url()).not.toContain(token);
  await expect(bob.getByText("Ann's Words game")).toBeVisible();
  await expectAccessible(bob);
  await bob.getByRole("button", { name: "Join" }).click();
  await expect(bob.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await expect(
    bob.getByText("Waiting for the creator to start the game. You can still decline."),
  ).toBeVisible();

  // Every seat is filled, and still the game waits for Ann.
  await refocus(ann);
  await expect(ann.getByRole("listitem").filter({ hasText: "Bob" })).toBeVisible(FAR);
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await ann.getByRole("button", { name: "Start game" }).click();
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  await refocus(bob);
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
});
