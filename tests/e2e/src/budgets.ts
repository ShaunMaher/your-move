/**
 * The e2e suite's time budgets, in one place. Each is a deliberate limit sized from measured CI
 * runs (issue #7), never a retry (11 §4); playwright.config.ts explains how they fit together.
 */

/**
 * Each test, including its test-scoped fixtures (`context`, `page`, `cspViolations`): Playwright's
 * default, kept. Once a worker's browser is warm, the slowest test seen on a loaded CI runner took
 * 8.3 s, so this leaves more than 3× headroom for the tests themselves.
 */
export const TEST_TIMEOUT_MS = 30_000;

/**
 * One browser launch (`browserType.launch`). Playwright's `browser` fixture has no fixture
 * timeout of its own, so this is the only limit on a launch. The slowest launch seen to succeed on
 * CI took 67 s (Chromium, 3 pipelines on the runner); 120 s is about twice that. A launch that
 * outlives it has hung rather than slowed (the one seen did not finish in 180 s, while the three
 * launches after it in the same job took 1–15 s), and failing it a minute sooner than Playwright's
 * 180 s default changes nothing else.
 */
export const LAUNCH_TIMEOUT_MS = 120_000;

/**
 * The per-worker warm-up (`browserWarmup` in fixtures.ts): the first context, page and page load
 * of a freshly launched browser. That first page is the one-off cost the first test of each shard
 * used to pay inside its 30 s: a passing first test took up to 23 s on a loaded runner against
 * 1–8 s for the tests after it, and two failed with the first page still opening after 28–30 s.
 * 90 s is three times the budget those failures ran out of. Reproduced locally (the pinned image,
 * half a CPU, a 30 s CPU spike from the first content process on), WebKit's warm-up took 37–39 s
 * and the first test then 3–4 s, where without it the first test failed at 35–38 s.
 */
export const WARMUP_TIMEOUT_MS = 90_000;

/**
 * A test in which two people play a game (game.spec.ts): sign-ins, an invitation, several real
 * moves each checked against the server, and a resignation, across two browser contexts. Not the
 * 30 s of a single-page test (ADR 0004 records the exception). Measured locally in the pinned
 * image, a warm browser and nothing else running: see the figures in the A4 review record; a
 * loaded CI runner is several times slower, so 120 s is a guess of that margin, not a
 * measurement. TO BE RE-MEASURED on the CI runner from the first pipeline that runs it (the
 * owner feeds the number back); then this value and the one in the ADR are set from it.
 */
export const GAME_TEST_TIMEOUT_MS = 120_000;

/** The part of `GAME_TEST_TIMEOUT_MS` the moves loop may use, so a stuck game fails an assertion first. */
export const GAME_LOOP_BUDGET_MS = 60_000;

/**
 * The short game test: two sign-ins, an invitation, and a resignation straight after the start,
 * with no moves. Between a single-page test and the full game; 60 s is twice the 30 s of the
 * former, the same to-be-measured margin as the full game's.
 */
export const RESIGN_TEST_TIMEOUT_MS = 60_000;

/**
 * The rematch test (opponents.spec.ts, alpha A12): two sign-ins, an invitation, one pass each and
 * a resignation, then a second game started by picking the other person from the list. The short
 * game test plus two moves and a second game; 90 s sits between that test's 60 s and the full
 * game's 120 s, the same to-be-measured margin as theirs. Measured locally in the pinned image
 * with a warm browser: 5.0 s (Chromium) and 6.3 s (WebKit), 2026-11-26. Alpha A15 adds a third
 * game from the finished game's Rematch button, opened by both players: in the pinned image,
 * 6.1 s (Chromium) and 7.7 s (WebKit) in a full run, and 14.7 s and 11.9 s as the first test of a
 * run (a cold browser), 2026-11-27; still well inside 90 s.
 */
export const REMATCH_TEST_TIMEOUT_MS = 90_000;

/**
 * The no-play hint test (no-play.spec.ts, alpha A14): two sign-ins, an invitation, and the first
 * player's board with the word list downloaded and searched; no moves. The same steps as the short
 * game test, so the same 60 s. Measured locally in the pinned image with a warm browser: 1.7 s
 * (Chromium) and 2.4 s (WebKit), 2026-11-27.
 */
export const NO_PLAY_TEST_TIMEOUT_MS = 60_000;

/**
 * The email invite test (invites.spec.ts, alpha A17): one sign-in, a game for an address with no
 * account, the invitation email read from the capture, the second person's sign-up from it, an
 * accept and a pass each, then the email's unsubscribe page. The short game test's steps and two
 * moves, so the same 60 s for now. TO BE MEASURED in the pinned image and on CI.
 */
export const INVITE_TEST_TIMEOUT_MS = 60_000;
