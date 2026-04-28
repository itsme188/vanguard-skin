import { db } from "@/lib/db";
import {
  getEarningsSettings,
  setEarningsEmailsEnabled,
  setMutedEarningsSymbols,
} from "@/lib/queries/earnings-settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/settings/earnings — Returns the current earnings-email settings.
 *
 * Shape: { enabled: boolean, mutedSymbols: string[] }
 *
 * No auth — these are user prefs scoped to the local app, not secrets.
 */
export async function GET() {
  const settings = getEarningsSettings(db);
  return Response.json(settings);
}

/**
 * PATCH /api/settings/earnings — Update one or both fields.
 *
 * Body: { enabled?: boolean, mutedSymbols?: string[] }
 *
 * Either field is optional; only the provided keys are written. Symbols
 * are upper-cased + deduped server-side. Returns the new full state so
 * the UI can render without a follow-up GET.
 */
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    enabled?: boolean;
    mutedSymbols?: string[];
  };

  if (typeof body.enabled === "boolean") {
    setEarningsEmailsEnabled(db, body.enabled);
  }
  if (Array.isArray(body.mutedSymbols)) {
    if (body.mutedSymbols.some((s) => typeof s !== "string")) {
      return Response.json(
        { error: "mutedSymbols must be an array of strings." },
        { status: 400 },
      );
    }
    setMutedEarningsSymbols(db, body.mutedSymbols);
  }

  return Response.json(getEarningsSettings(db));
}
