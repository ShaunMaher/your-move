/**
 * Inviting someone with no account by email (alpha A17; docs/spec/06-auth.md §6.3, §6.4, 07 §1.1,
 * 05 §Email links): Ann creates a words game for an address nobody has signed up with, the console
 * provider captures the invitation, Bob follows its link, signs up with that address, finds the
 * invitation waiting, accepts, and both make a move. Then the email's unsubscribe page, with the
 * service worker in charge of Ann's page, is answered by the server.
 */
import { INVITE_TEST_TIMEOUT_MS } from "./budgets.js";
import { expect, test } from "./fixtures.js";
import { FAR, isMyTurn, refocus } from "./game-steps.js";
import { emailTo, expectAccessible, freshAddress, signUp } from "./helpers.js";
import { pass } from "./words-player.js";

test("someone with no account is invited by email, signs up from it and plays", async ({
  page: ann,
  friend: bob,
  baseURL,
}) => {
  test.setTimeout(INVITE_TEST_TIMEOUT_MS);
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");

  // Ann invites the address. The note says what it gets, never whether it has an account.
  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Words/u }).click();
  await expect(ann.getByRole("button", { name: "Next" })).toBeEnabled();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Their email address").fill(bobAddress);
  await expect(
    ann.getByText(/We'll email them an invitation from you, showing your name and email address/u),
  ).toBeVisible();
  await expectAccessible(ann);
  await ann.getByRole("button", { name: "Review" }).click();
  await expect(ann.getByText(`Check the address: ${bobAddress}`)).toBeVisible();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  // The creator sees the seat as the address she typed.
  await expect(ann.getByRole("region", { name: "Players" })).toContainText(bobAddress);
  const gameId = /\/g\/([^/]+)$/u.exec(new URL(ann.url()).pathname)?.[1] ?? "";
  expect(gameId).not.toBe("");

  // The invitation, as the console provider captured it.
  const invitation = await emailTo(ann.request, bobAddress, / invited you to play /u);
  expect(invitation.subject).toBe("Ann invited you to play Words on E2E Games");
  expect(invitation.text).toContain("Ann (");
  expect(invitation.text).not.toContain(gameId);
  const link = /sign in with this email address at (\S+)/u.exec(invitation.text)?.[1] ?? "";
  expect(new URL(link).origin).toBe(new URL(baseURL ?? "").origin);

  // Bob follows the link and signs up with that address; the invitation waits in his list.
  await bob.goto(link);
  await signUp(bob, bobAddress, "Bob");
  const invitations = bob.getByRole("region", { name: /Invitations/u });
  await expect(invitations).toBeVisible();
  await expectAccessible(bob);
  await invitations.getByRole("link", { name: /Words with Ann/u }).click();
  await expect(bob.getByText("Ann invited you to play.")).toBeVisible();
  await bob.getByRole("button", { name: "Accept" }).click();

  // Every seat is filled, so the game starts; both are on the board and each passes once.
  await expect(bob.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  await refocus(ann);
  await expect(ann.getByRole("region", { name: "Words board" })).toBeVisible(FAR);
  for (let moves = 0; moves < 2; moves++) {
    for (const page of [ann, bob]) await refocus(page);
    await expect.poll(async () => (await isMyTurn(ann)) || (await isMyTurn(bob)), FAR).toBe(true);
    const mover = (await isMyTurn(ann)) ? ann : bob;
    await pass(mover);
    await expect.poll(() => isMyTurn(mover), FAR).toBe(false);
  }

  // The unsubscribe link is the server's page even with the service worker in charge (07 §4):
  // a confirm button, then done.
  await ann.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await ann.goto(invitation.listUnsubscribe ?? "");
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Stop invitation emails?");
  await ann.getByRole("button", { name: "Don't send me invites again" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("No more invitation emails");
});
