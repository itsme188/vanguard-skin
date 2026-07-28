/**
 * Outcome message for the alerts-inbox "Suggest all" run.
 *
 * Honest-button-feedback rule: an all-failure run ({generated: 0, failed: N})
 * must report the failures — pre-fix it collapsed into the no-op message and
 * the 6 suggestion-less pending alerts read as "by design"
 * (qa: alerts-inbox--suggest-all-reports-noop-when-all-failed).
 */
export function suggestOutcomeMessage(
  generated: number,
  failed: number | undefined
): string {
  const failedCount = failed ?? 0;
  if (generated > 0) {
    const plural = generated === 1 ? "suggestion" : "suggestions";
    const failedNote = failedCount > 0 ? ` (${failedCount} failed)` : "";
    return `Generated ${generated} ${plural}${failedNote}.`;
  }
  if (failedCount > 0) {
    return `No suggestions generated — ${failedCount} failed. Existing suggestions are unaffected; see the server log for the cause.`;
  }
  return "No pending alerts needed a suggestion.";
}
