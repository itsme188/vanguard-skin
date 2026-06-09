import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { FEATURE_MODELS, resolveFeatureModel } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getFeatureModelOverrides } from "@/lib/queries/ai-model-overrides";
import { setFeatureModelOverride } from "@/lib/mutations/ai-model-overrides";

export const dynamic = "force-dynamic";

/**
 * Settings → AI Models. In-app route (no cron auth), mirrors the
 * email-recipients pattern: overrides live in the SQLite `settings`
 * key-value table so changes apply immediately — no app restart, no
 * Electron env-var threading.
 */

interface FeatureModelRow {
  key: FeatureKey;
  defaultModel: string;
  override: string | null;
  effective: string;
}

function listFeatures(): FeatureModelRow[] {
  const overrides = getFeatureModelOverrides(db);
  return (Object.keys(FEATURE_MODELS) as FeatureKey[]).map((key) => {
    const defaultModel = FEATURE_MODELS[key];
    const override = overrides[key] ?? null;
    // resolveFeatureModel applies the same override-first / fall-back-on-
    // malformed logic the AI call sites use, so "effective" is honest.
    const { provider, modelId } = resolveFeatureModel(key);
    return { key, defaultModel, override, effective: `${provider}/${modelId}` };
  });
}

/**
 * GET /api/settings/ai-models
 * → { success: true, features: [{ key, defaultModel, override, effective }] }
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ success: true, features: listFeatures() });
}

/**
 * PATCH /api/settings/ai-models
 * Body: { key: FeatureKey, model: "<provider>/<model-id>" | null }
 * null clears the override (falls back to the FEATURE_MODELS default).
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  let body: { key?: unknown; model?: unknown };
  try {
    body = (await req.json()) as { key?: unknown; model?: unknown };
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const key = body.key;
  if (typeof key !== "string" || !(key in FEATURE_MODELS)) {
    return NextResponse.json(
      { success: false, error: `Unknown feature key "${String(key)}"` },
      { status: 400 },
    );
  }

  const model = body.model ?? null;
  if (model !== null && typeof model !== "string") {
    return NextResponse.json(
      { success: false, error: "model must be a string or null" },
      { status: 400 },
    );
  }

  try {
    setFeatureModelOverride(db, key as FeatureKey, model);
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Failed to save override",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ success: true, features: listFeatures() });
}
