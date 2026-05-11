import { db } from "@/lib/db";
import {
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";
import { computeSecurityRegression } from "@/lib/compute/security-regression";

export const dynamic = "force-dynamic";

/**
 * GET /api/security/[id]/regression?benchmark=SPY
 *
 * Cache-first: tries `security_regressions` for today, falls back to a fresh
 * compute (and writes it back to the cache on success). Returns null body when
 * neither cache nor compute produces a result (insufficient price history).
 *
 * 400 on non-integer id. Defaults benchmark to SPY when missing.
 *
 * Validation skeleton mirrors /api/analysis/narrative/route.ts.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const securityId = parseInt(id, 10);
  if (isNaN(securityId)) {
    return Response.json(
      { success: false, error: "Invalid security id" },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const benchmark = (url.searchParams.get("benchmark") ?? "SPY").toUpperCase();

  try {
    const cached = getCachedRegression(db, securityId, benchmark);
    if (cached) {
      return Response.json({ success: true, data: cached, fromCache: true });
    }

    const fresh = computeSecurityRegression(db, securityId, benchmark);
    if (fresh) {
      upsertRegression(db, {
        securityId,
        benchmarkSymbol: benchmark,
        result: fresh,
      });
      return Response.json({ success: true, data: fresh, fromCache: false });
    }

    // Insufficient price history — null body, 200 status (not an error).
    return Response.json({ success: true, data: null, fromCache: false });
  } catch (e) {
    return Response.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Failed",
      },
      { status: 500 }
    );
  }
}
