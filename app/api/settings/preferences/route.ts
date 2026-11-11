import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getAppPreferences } from "@/lib/queries/app-preferences";
import { applyPreferencesPatch } from "@/lib/mutations/app-preferences";

export const dynamic = "force-dynamic";

/** GET /api/settings/preferences — read-only; writes nothing. */
export async function GET(): Promise<Response> {
  return NextResponse.json({ success: true, data: getAppPreferences(db) });
}

/** PATCH /api/settings/preferences — any subset of the four preference fields. */
export async function PATCH(req: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Request body must be valid JSON." }, { status: 400 });
  }
  const result = applyPreferencesPatch(db, body);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, data: result.data });
}
