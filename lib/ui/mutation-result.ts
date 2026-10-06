/**
 * One shared reader for a mutating fetch (U21, 2026-10-05).
 *
 * The project rule: every mutating handler checks `res.ok` AND `data.success`,
 * explains a failure in plain domain language and never prints a raw exception
 * (`Failed to fetch`, a SyntaxError off a non-JSON 500). This helper parses the
 * body defensively and returns a tagged result so a handler is one branch:
 *
 *   const r = await readMutationResult<{ id: number }>(res);
 *   if (!r.ok) { setError(r.message); return; }
 *
 * Generalises `describeNoteSaveFailure` (lib/notes/save-failure-copy.ts), which
 * stays the notes-specific wording.
 */
export type MutationResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; message: string; status: number };

interface Envelope {
  success?: unknown;
  error?: unknown;
}

export async function readMutationResult<T = unknown>(
  res: Response,
): Promise<MutationResult<T>> {
  const body = (await res.json().catch(() => null)) as (Envelope & Record<string, unknown>) | null;
  if (res.ok && body && body.success === true) {
    return { ok: true, data: body as unknown as T };
  }
  const serverText =
    body && typeof body.error === "string" && body.error.trim().length > 0
      ? body.error.trim()
      : null;
  return {
    ok: false,
    status: res.status,
    message: serverText ?? `The server returned an error (HTTP ${res.status}).`,
  };
}

/** Copy for a fetch that never got a response (offline, server down). */
export function networkFailureMessage(action = "complete that action"): string {
  return `Couldn't ${action}: could not reach the server. Try again.`;
}
