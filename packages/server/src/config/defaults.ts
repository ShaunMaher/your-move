/**
 * The one place the product's default display name may appear (CLAUDE.md: never hard-code the
 * product name; `APP_NAME` overrides it, docs/spec/09-operations.md §1). Lint forbids the literal
 * everywhere else.
 */
export const DEFAULT_APP_NAME = "Your Move";
