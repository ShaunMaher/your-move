/**
 * The OpenAPI error responses every route module documents (docs/spec/05-api.md §Errors): one
 * helper, so the route modules share it rather than each keeping a copy (alpha A23 review P-15).
 */
import { ErrorResponseSchema } from "./errors.js";

/** The shared error body as a response's content. */
export const errorContent = { "application/json": { schema: ErrorResponseSchema } } as const;

/** Error responses by status, each with the shared error body (05 §Errors). */
export function errors<const T extends Readonly<Record<number, string>>>(
  descriptions: T,
): { [K in keyof T]: { description: string; content: typeof errorContent } } {
  return Object.fromEntries(
    Object.entries(descriptions).map(([status, description]) => [
      status,
      { description, content: errorContent },
    ]),
  ) as { [K in keyof T]: { description: string; content: typeof errorContent } };
}
