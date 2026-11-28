# Alpha A9 review — resolutions

This record covers round 1 of the review of alpha slice A9, the theme choice (`alpha-a9-theme`):
the picky review (A9-P). Each line gives the finding's ID, its outcome and where the fix lives.
The spec changes are folded into v0.9.24 (the README history line).

## Picky review (A9-P)

| ID | Outcome | Where |
|---|---|---|
| A9-P-1 | Fixed. The radios show and apply the choice at once, then save; a failed save puts the old theme back (state and applied theme) and shows the usual problem message, and a saved one says "Theme saved" in a polite status line. The radios and the email nudges checkbox are no longer disabled during a save (a change during a save is ignored), so focus stays on the control. Tests: the choice shows and applies before the server answers and focus stays; a server error and a network failure each roll back, including the stored copy. | `apps/web/src/screens/Settings.tsx`, `Settings.test.tsx`, 07 §5 |
| A9-P-2 | Fixed. `applyTheme` and the start-up path treat anything but the three words as `"system"`. Test with a bogus value. | `apps/web/src/theme.ts`, `theme.test.ts` |
| A9-P-3 | Fixed. A unit test reads `styles.css` and checks the two dark token blocks declare the same properties with the same values, and that they cover every colour the light theme declares. | `apps/web/src/styles.test.ts` |
| A9-P-4 | Fixed. The group is a `fieldset` whose `legend` holds the "Appearance" heading, so the name is announced once. Test: the group is found by that name. | `apps/web/src/screens/Settings.tsx`, `styles.css`, `Settings.test.tsx` |
