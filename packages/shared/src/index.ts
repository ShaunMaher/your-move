/**
 * Zod schemas for the public API and WebSocket protocol: one schema per endpoint, the source of
 * the OpenAPI document and of `@your-move/api-client` (docs/spec/05-api.md §Versioning).
 */
export {
  deleteMeRoute,
  DeleteMeBodySchema,
  deleteOtpRoute,
  EmptyObjectSchema,
  getMeRoute,
  LogoutAllBodySchema,
  logoutAllRoute,
  logoutRoute,
  MeSchema,
  OtpRequestBodySchema,
  otpRequestRoute,
  OtpVerifyBodySchema,
  OtpVerifyResponseSchema,
  otpVerifyRoute,
  PatchMeBodySchema,
  patchMeRoute,
  UserSettingsSchema,
  type Me,
} from "./auth.js";
export { ERROR_CODES, ErrorResponseSchema, type ErrorCode, type ErrorResponse } from "./errors.js";
export {
  API_V1,
  ClientConfigSchema,
  configRoute,
  HealthResponseSchema,
  healthRoute,
} from "./routes.js";
