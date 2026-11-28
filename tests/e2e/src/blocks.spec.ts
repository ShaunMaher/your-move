/**
 * Blocking (alpha A23, 07 §1, 05 §Blocks, 06 §6.10): Bob opens Ann's invitation and blocks her
 * from it, after a dialog that says what a block does; he is back on his game list with no
 * invitation, and Ann's game shows only that Bob declined. Then Bob finds Ann under Settings'
 * *Blocked players* and unblocks her.
 */
import { expect, test } from "./fixtures.js";
import { FAR, refocus } from "./game-steps.js";
import { expectAccessible, freshAddress, signUp } from "./helpers.js";

test("an invitee blocks the inviter from the invitation, then unblocks her in Settings", async ({
  page: ann,
  friend: bob,
}) => {
  const bobAddress = freshAddress();
  await signUp(ann, freshAddress(), "Ann");
  await signUp(bob, bobAddress, "Bob");

  await ann.getByRole("link", { name: "New game" }).click();
  await ann.getByRole("button", { name: /^Words/u }).click();
  await ann.getByRole("button", { name: "Next" }).click();
  await ann.getByLabel("Their email address").fill(bobAddress);
  await ann.getByRole("button", { name: "Review" }).click();
  await ann.getByRole("button", { name: "Create game" }).click();
  await expect(ann.getByRole("heading", { level: 1 })).toHaveText("Words lobby");

  await bob.goto("/");
  const invitations = bob.getByRole("region", { name: /Invitations/u });
  await invitations.getByRole("link", { name: /Words with Ann/u }).click(FAR);
  await expect(bob.getByRole("heading", { level: 1 })).toHaveText("Words lobby");
  await bob.getByRole("button", { name: "Block Ann" }).click();
  const dialog = bob.getByRole("dialog", { name: "Block Ann?" });
  await expect(dialog).toContainText("They won't be told");
  await expect(dialog).toContainText("Games you're already playing carry on.");
  await expectAccessible(bob);
  await dialog.getByRole("button", { name: "Block" }).click();

  // Back on the list, with the invitation gone.
  await expect(bob).toHaveURL(/\/$/u);
  await expect(bob.getByRole("region", { name: /Invitations/u })).toHaveCount(0);

  // To Ann it is a decline like any other: her two-seat lobby ends as Bob's own Decline would
  // end it, with no mention of a block.
  await refocus(ann);
  await expect(ann.getByText("Declined, no result")).toBeVisible(FAR);
  await expect(ann.getByText(/block/iu)).toHaveCount(0);

  await bob.goto("/settings");
  const blocked = bob.getByRole("region", { name: "Blocked players" });
  await expect(blocked.getByRole("listitem").filter({ hasText: "Ann" })).toBeVisible(FAR);
  await expectAccessible(bob);
  await blocked.getByRole("button", { name: "Unblock Ann" }).click();
  const unblock = bob.getByRole("dialog", { name: "Unblock Ann?" });
  await expect(unblock).toContainText("They'll be able to invite you to games again.");
  await unblock.getByRole("button", { name: "Unblock" }).click();
  await expect(blocked.getByText("You haven't blocked anyone.")).toBeVisible(FAR);
});
