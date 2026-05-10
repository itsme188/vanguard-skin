import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeExposureDelta, type HypotheticalLeg } from "@/lib/compute/exposure-delta";
import { resolveScope } from "@/lib/queries/accounts";

interface WhatIfRequest {
  scope?: string;
  legs?: HypotheticalLeg[];
}

function isValidLeg(x: unknown): x is HypotheticalLeg {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    typeof obj.symbol === "string" &&
    (obj.action === "buy" || obj.action === "sell") &&
    typeof obj.dollarAmount === "number" &&
    Number.isFinite(obj.dollarAmount)
  );
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as WhatIfRequest;
    const scope = typeof body.scope === "string" ? body.scope : "all";
    const legsRaw = Array.isArray(body.legs) ? body.legs : [];
    const legs: HypotheticalLeg[] = legsRaw.filter(isValidLeg);

    const accountIds = resolveScope(db, scope);
    const delta = computeExposureDelta(db, scope, accountIds, legs);

    return NextResponse.json({ success: true, data: delta });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
