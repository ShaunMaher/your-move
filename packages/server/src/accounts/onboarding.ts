/**
 * Onboarding state (docs/spec/06-auth.md §5): a display name and the age confirmation for the
 * `MIN_AGE` in force. An operator who raises `MIN_AGE` re-prompts everyone who confirmed a lower
 * value (or none, as accounts onboarded before the confirmation existed): they still count as
 * onboarded for other players (`onboarded_at` is never cleared), but the gated endpoints refuse
 * them until they confirm again.
 */
import type { UserRecord } from "../db/repositories.js";

type OnboardingFields = Pick<UserRecord, "onboardedAt" | "ageAttestedMinAge">;

/** Whether the user has confirmed they are at least the current `MIN_AGE`. */
export function ageConfirmed(user: Pick<UserRecord, "ageAttestedMinAge">, minAge: number): boolean {
  return user.ageAttestedMinAge !== null && user.ageAttestedMinAge >= minAge;
}

/**
 * `needsOnboarding` (05 `GET /api/v1/me`): onboarding was never completed, or the age confirmation
 * is missing or below the current `MIN_AGE` (a re-prompt).
 */
export function needsOnboarding(user: OnboardingFields, minAge: number): boolean {
  return user.onboardedAt === null || !ageConfirmed(user, minAge);
}
