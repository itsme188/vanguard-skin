/**
 * GET /api/analysis/drill-down — backs the P3 Slice C DrillDownPanel.
 *
 * Validates the discriminated-union `DrillDownFilter` from query params, then
 * resolves `scope` → `accountIds` and hands off to `getHoldingsInBucket`.
 *
 * Per-kind required params:
 *   - classification: dimension + bucket
 *   - factor:         factor + bucket
 *   - sector:         sector
 *   - risk:           optional topN (clamped to [1, 100] inside the query)
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveScope } from "@/lib/queries/accounts";
import {
  getHoldingsInBucket,
  type DrillDownFilter,
} from "@/lib/queries/drill-down";
import { FACTOR_COLUMNS } from "@/lib/factors";

export const dynamic = "force-dynamic";

const ALLOWED_DIMS = [
  "sector",
  "fund_category",
  "geography",
  "market_cap_category",
  "style",
  "asset_class",
  "security_type",
] as const;

const ALLOWED_KINDS = ["classification", "factor", "sector", "risk"] as const;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const kind = url.searchParams.get("kind");

  if (!scope) {
    return NextResponse.json(
      { success: false, error: "scope required" },
      { status: 400 }
    );
  }
  if (!kind || !(ALLOWED_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { success: false, error: "unknown kind" },
      { status: 400 }
    );
  }

  let filter: DrillDownFilter;
  if (kind === "classification") {
    const dimension = url.searchParams.get("dimension");
    const bucket = url.searchParams.get("bucket");
    if (
      !dimension ||
      !(ALLOWED_DIMS as readonly string[]).includes(dimension)
    ) {
      return NextResponse.json(
        { success: false, error: "unknown dimension" },
        { status: 400 }
      );
    }
    if (!bucket) {
      return NextResponse.json(
        { success: false, error: "bucket required" },
        { status: 400 }
      );
    }
    filter = {
      kind: "classification",
      dimension: dimension as (typeof ALLOWED_DIMS)[number],
      bucket,
    };
  } else if (kind === "factor") {
    const factor = url.searchParams.get("factor");
    const bucket = url.searchParams.get("bucket");
    if (
      !factor ||
      !(FACTOR_COLUMNS as readonly string[]).includes(factor)
    ) {
      return NextResponse.json(
        { success: false, error: "unknown factor" },
        { status: 400 }
      );
    }
    if (!bucket) {
      return NextResponse.json(
        { success: false, error: "bucket required" },
        { status: 400 }
      );
    }
    filter = {
      kind: "factor",
      factor: factor as (typeof FACTOR_COLUMNS)[number],
      bucket,
    };
  } else if (kind === "sector") {
    const sector = url.searchParams.get("sector");
    if (!sector) {
      return NextResponse.json(
        { success: false, error: "sector required" },
        { status: 400 }
      );
    }
    filter = { kind: "sector", sector };
  } else {
    // kind === "risk"
    const topNStr = url.searchParams.get("topN");
    let topN: number | undefined;
    if (topNStr != null) {
      const parsed = parseInt(topNStr, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
        return NextResponse.json(
          { success: false, error: "topN must be between 1 and 100" },
          { status: 400 }
        );
      }
      topN = parsed;
    }
    filter = { kind: "risk", topN };
  }

  try {
    const accountIds = resolveScope(db, scope);
    const rows = getHoldingsInBucket(db, scope, filter, accountIds);
    return NextResponse.json({ success: true, rows });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : "Failed" },
      { status: 500 }
    );
  }
}
