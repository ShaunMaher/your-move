// Conventional Commits (docs/spec/11-engineering.md §7), checked on every commit in an MR and on
// the MR title.
export default {
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
  },
};
