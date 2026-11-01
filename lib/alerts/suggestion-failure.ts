/**
 * Import-free (client-safe): which alert-suggestion failures a Retry cannot
 * fix. The AI account or its setup is at fault, not this alert.
 */
export function isFinalSuggestionFailure(reason: unknown): boolean {
  return reason === "ai_account" || reason === "ai_not_configured";
}
