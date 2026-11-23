/** The configuration both runtimes run the contract suite with (test fixtures, not secrets). */
export const CONTRACT_VARS = {
  PUBLIC_URL: "https://play.example.org",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "no-reply@example.org",
  OPERATOR_CONTACT: "ops@example.org",
} as const;

export const CONTRACT_SECRETS = {
  APP_SECRET: btoa("contract-tests-only-0123456789abcdef"),
  EMAIL_API_KEY: "contract-tests-only",
} as const;
