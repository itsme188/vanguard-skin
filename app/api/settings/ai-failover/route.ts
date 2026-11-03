import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildFailoverView } from "@/lib/ai/failover-view";
import { getFailoverEnabledFeatures, getFailoverFallbacks } from "@/lib/queries/ai-failover-settings";
import {
  setFailoverEnabled,
  setFailoverFallbacks,
  setFailoverGroupEnabled,
} from "@/lib/mutations/ai-failover-settings";

export const dynamic = "force-dynamic";

/**
 * Settings → AI failover (provider-failover design §7, slice 4). In-app route,
 * same shape as /api/settings/ai-models. Everything is bounded by the section 4
 * ceiling inside the mutations: a parked feature answers 400 and nothing is saved.
 * Nothing is on until the owner turns it on.
 */

function view() {
  return buildFailoverView(getFailoverEnabledFeatures(db), getFailoverFallbacks(db));
}

/** GET → { success: true, ...view } */
export async function GET(): Promise<Response> {
  return NextResponse.json({ success: true, ...view() });
}

/**
 * PATCH body, one of:
 *   { key, enabled: boolean }                    switch one feature
 *   { key, fallbacks: string[] | null }          set / clear its ordered list
 *   { group: "earningsPrep", enabled: boolean }  switch the print-prep group
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  let body: { key?: unknown; enabled?: unknown; fallbacks?: unknown; group?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const bad = (error: string) => NextResponse.json({ success: false, error }, { status: 400 });

  try {
    if (body.group !== undefined) {
      if (body.group !== "earningsPrep") return bad(`Unknown group "${String(body.group)}"`);
      if (typeof body.enabled !== "boolean") return bad("enabled must be true or false");
      setFailoverGroupEnabled(db, body.enabled);
    } else if (typeof body.key === "string") {
      if (body.enabled === undefined && body.fallbacks === undefined) {
        return bad("Nothing to change: send enabled or fallbacks");
      }
      const { key, enabled, fallbacks } = body;
      if (enabled !== undefined && typeof enabled !== "boolean") return bad("enabled must be true or false");
      if (
        fallbacks !== undefined &&
        fallbacks !== null &&
        !(Array.isArray(fallbacks) && fallbacks.every((s) => typeof s === "string"))
      ) {
        return bad("fallbacks must be a list of strings or null");
      }
      // One transaction: a rejected list leaves the enable flag untouched too.
      db.transaction(() => {
        if (enabled !== undefined) setFailoverEnabled(db, key, enabled);
        if (fallbacks !== undefined) setFailoverFallbacks(db, key, fallbacks as string[] | null);
      })();
    } else {
      return bad("Send a feature key or a group");
    }
  } catch (err) {
    return bad(err instanceof Error ? err.message : "Failed to save");
  }
  return NextResponse.json({ success: true, ...view() });
}
