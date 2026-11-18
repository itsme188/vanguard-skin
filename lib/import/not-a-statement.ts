/**
 * Start of the message for a file that is not a Vanguard statement. Import-free
 * so the Import tab (a client component) can match it without pulling in the
 * server-side classifier and its SDK. `lib/import/error-classify.ts` builds the
 * message from it.
 */
export const NOT_A_STATEMENT_PREFIX = "This file doesn't look like a Vanguard brokerage statement.";
