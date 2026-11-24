/**
 * A normalised email address (04 conventions: trimmed, Unicode NFC, lower-cased, a pragmatic
 * address shape, at most 254 characters). The brand means only the normaliser can produce one, so
 * `emailId` and lookups can never be fed a raw, unnormalised address — which would silently miss
 * suppression-list entries (M2a review S-9).
 *
 * The normaliser itself arrives with sign-in in M2b, which settles the address regex 04 leaves
 * open; until then nothing produces this type outside tests.
 */
declare const normalised: unique symbol;

export type NormalisedEmail = string & { readonly [normalised]: true };
