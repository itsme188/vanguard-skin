/**
 * Domain-language copy for a note create/update/delete that did not succeed
 * (QA 2026-09-07, finding research-notes-composer--raw-failed-to-fetch-error-text;
 * mirrored into the NotesAmbient overlay 2026-09-15, finding
 * notes-ambient--save-failure-prints-raw-failed-to-fetch).
 *
 * The composer used to print `err.message`, so a network-level failure showed
 * the browser's raw "Failed to fetch" between the Tags input and the Save
 * Note button — and the edit/delete handlers had the same defect one layer
 * worse (a `throw new Error(data.error)` off an UNCHECKED `res.ok`, so a
 * non-JSON 500 threw a raw SyntaxError into the toast instead). Mirrors the
 * wording the Documents tag editor already uses for the same two failures
 * (see ResearchDocumentsView.tsx::commit).
 *
 * `action` picks the subject verb — defaults to "save" (the create-note
 * composer's error strip and the NotesAmbient overlay's footer status line);
 * "update"/"delete" are the edit/delete toasts.
 *
 * A 4xx body is echoed — those are this route's validation messages
 * ("Missing required fields: note_type, content") and the user can act on
 * them. A 5xx body is NOT: those carry raw exception text.
 *
 * Lives in `lib/notes/` (not inline in NotesView.tsx, which re-exports it for
 * the existing `describeNoteSaveFailure` import sites) because NotesAmbient
 * is rendered globally from the dashboard layout — importing straight from
 * NotesView would drag its whole component graph (TranscriptCard,
 * ConfirmDialog, EmptyState, Toast, PrivateText, …) into every page's client
 * bundle just for this one pure function.
 */
export function describeNoteSaveFailure(
  failure: (
    | { kind: "network" }
    | { kind: "server"; status: number; error?: unknown }
    | { kind: "unknown" }
  ) & { action?: "save" | "update" | "delete" },
): string {
  const action = failure.action ?? "save";
  const verb = action === "update" ? "update" : action === "delete" ? "delete" : "save";
  const retryTail =
    action === "delete"
      ? "Try again."
      : action === "update"
        ? "Your changes are still here — try again."
        : "Your note is still here — try again.";

  if (failure.kind === "network") {
    return `Couldn't ${verb} the note: could not reach the server. ${retryTail}`;
  }
  if (failure.kind === "server") {
    const detail =
      failure.status < 500 &&
      typeof failure.error === "string" &&
      failure.error.trim().length > 0
        ? failure.error.trim()
        : null;
    return detail
      ? `Couldn't ${verb} the note: ${detail}`
      : `Couldn't ${verb} the note (server returned ${failure.status}). ${retryTail}`;
  }
  return `Couldn't ${verb} the note — something went wrong. ${retryTail}`;
}
