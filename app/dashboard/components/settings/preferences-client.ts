/**
 * Client-side reader and writer for the SQLite-backed owner preferences
 * (`GET` / `PATCH /api/settings/preferences`).
 *
 * These rows live in the SQLite `settings` table, which every cron tick reads
 * fresh, so a change here applies on the next tick with NO app restart. That
 * is the opposite of the `AppSettings` fields in `settings-fields.ts`, which
 * are injected as environment variables at boot. The page says which is which
 * next to each group, because it changes what the owner has to do next.
 *
 * The route is enveloped (`{success, data}`), so the reply is read through the
 * shared `readMutationResult`. Every mutating request on the Settings page's
 * preference controls goes through `patchPreferences` below, which is why
 * those three components carry no fetch of their own.
 */

import apiFetch from "@/lib/http/apiFetch";
import { networkFailureMessage, readMutationResult } from "@/lib/ui/mutation-result";
import { joinSentences } from "@/lib/ui/join-sentences";
import type { AppPreferences, CapScope, Caps } from "@/lib/queries/app-preferences";

export type { AppPreferences, CapScope, Caps };

/**
 * A subset of the preferences to send. `constructionCaps` may name one scope
 * only: the route writes the scopes it is given and leaves the rest alone, so
 * the four per-scope rows never collapse into one shared set of numbers.
 */
export type PreferencesPatch = Partial<Omit<AppPreferences, "constructionCaps">> & {
  constructionCaps?: Partial<Record<CapScope, Caps>>;
};

/** The four seeded scopes, in the order the page shows them. */
export const CAP_SCOPE_LABELS: readonly { scope: CapScope; label: string }[] = [
  { scope: "all", label: "All accounts together" },
  { scope: "vanguard", label: "Vanguard taxable" },
  { scope: "roth", label: "Roth IRA" },
  { scope: "ibkr", label: "Interactive Brokers" },
];

export type PreferencesLoad =
  | { ok: true; prefs: AppPreferences }
  | { ok: false; message: string };

/** Read the stored preferences. Reads only — the route writes nothing on GET. */
export async function loadPreferences(signal?: AbortSignal): Promise<PreferencesLoad> {
  let res: Response;
  try {
    res = await fetch("/api/settings/preferences", { signal });
  } catch {
    return { ok: false, message: networkFailureMessage("load these preferences") };
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: unknown; data?: AppPreferences; error?: unknown }
    | null;
  if (!res.ok || !body || body.success !== true || !body.data) {
    const serverText =
      body && typeof body.error === "string" && body.error.trim() ? body.error.trim() : null;
    return {
      ok: false,
      message: joinSentences(
        serverText ?? `The server returned an error (HTTP ${res.status}).`,
        "Reload the page to try again.",
      ),
    };
  }
  return { ok: true, prefs: body.data };
}

/**
 * Save a subset of the preferences. An absent field is left untouched, and a
 * refusal leaves every stored row exactly as it was — so a failure message
 * can honestly say nothing changed.
 */
export async function patchPreferences(
  updates: PreferencesPatch,
  action: string,
): Promise<PreferencesLoad> {
  let res: Response;
  try {
    res = await apiFetch("/api/settings/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updates),
    });
  } catch {
    return { ok: false, message: networkFailureMessage(action) };
  }
  const result = await readMutationResult<{ data: AppPreferences }>(res);
  if (!result.ok) {
    return {
      ok: false,
      message: joinSentences(`Couldn't ${action}: ${result.message}`, "Nothing was changed."),
    };
  }
  return { ok: true, prefs: result.data.data };
}
