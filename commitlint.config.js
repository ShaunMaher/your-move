// Conventional Commits (docs/spec/11-engineering.md §7), checked on every commit in an MR and on
// the MR title.
// Headers over the 100-character limit that reached the shared stack branches before CI ran on
// them (alpha, 2026-11). They can't be reworded without rewriting published history, so these
// exact headers are exempt; every new commit keeps the limit.
const GRANDFATHERED_LONG_HEADERS = new Set([
  "fix(web): end the session for a different user, announce sign-ins, clear game state when none is found",
  "test(node): typed-address blocks, whoCanAddMe nobody, and the M4 note on picked blocks (A12-P-2, P-3, P-7)",
  "fix(server): count only joined rows and picked invitations per (creator, userId) (A12-S2-1, A12-R2-1)",
  "docs(spec): A12 review round 2: the pair count, the nobody-pick decision, the pick marker, Decline (A12-S2-1, S2-2, R2-1, R2-3)",
  "fix(server): replace an unplayed rematch, carry over only who acted (A15-P-2, P-3, S-3, review round 1)",
  "docs(spec): a Workers cost model before the first Workers deployment; regenerate the SDK report after the stack",
  "fix(server): cap the onboarding claim per runtime, and the review's tests and spec alignment (A17-S-5, S-6, S-8, S-10, P-3–P-6, P-10, P-11)",
  "fix(server): stop invite emails for the rest of the UTC day once the instance cap is crossed (A17-S2-1, S2-3, S2-4, R2-1, R2-6–R2-9)",
  "docs(security): rewrite F-20 for the day stop and update F-16; the creation timing tests' own limit (A17-S2-1, R2-2, R2-3)",
  "fix(server): count the account-deleted email; pass the email budget through the tunnel compose (B2 round 1)",
  "fix(server): keep the deletion when counting its confirmation fails; the guard is a tripwire (B2 round 2)",
]);

export default {
  ignores: [(message) => GRANDFATHERED_LONG_HEADERS.has(message.split("\n", 1)[0].trim())],
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "chore",
        "refactor",
        "test",
        "build",
        "ci",
        "perf",
        "revert",
        "style",
      ],
    ],
    // Bodies carry reasoning and attribution trailers; wrap is a style choice, not a gate.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
    // Subjects may start with a slice, finding or issue ID ("A20 review round 1", "F-17 …"),
    // which reads as sentence case; the other capitalised forms stay refused.
    "subject-case": [2, "never", ["start-case", "pascal-case", "upper-case"]],
  },
};
