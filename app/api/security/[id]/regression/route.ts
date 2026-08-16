import { db } from "@/lib/db";
import {
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";
import { computeSecurityRegression } from "@/lib/compute/security-regression";

export const dynamic = "force-dynamic";

function parseSecurityId(id: string): number | null {
  const securityId = parseInt(id, 10);
  return isNaN(securityId) ? null : securityId;
}

function benchmarkOf(request: Request): string {
  const url = new URL(request.url);
  return (url.searchParams.get("benchmark") ?? "SPY").toUpperCase();
}

/**
 * GET /api/security/[id]/regression?benchmark=SPY
 *
 * SIDE-EFFECT-FREE read (#35 task 5): tries the `security_regressions` cache;
 * on a miss it computes fresh and RETURNS it but never writes the cache back —
 * a bare GET under SameSite=Lax carries no CSRF protection, so it may not
 * mutate. The compute is pure deterministic math over price history, so the
 * card populates identically; the write-back moved to POST for cache warming.
 * Returns null body when neither cache nor compute produces a result
 * (insufficient price history).
 *
 * 400 on non-integer id. Defaults benchmark to SPY when missing.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const securityId = parseSecurityId(id);
  if (securityId === null) {
    return Response.json(
      { success: false, error: "Invalid security id" },
      { status: 400 }
    );
  }

  const benchmark = benchmarkOf(request);

  try {
    const cached = getCachedRegression(db, securityId, benchmark);
    if (cached) {
      return Response.json({ success: true, data: cached, fromCache: true });
    }

    const fresh = computeSecurityRegression(db, securityId, benchmark);
    // NOTE: intentionally no cache write here — the persist lives on POST.
    return Response.json({ success: true, data: fresh ?? null, fromCache: false });
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

/**
 * POST /api/security/[id]/regression?benchmark=SPY
 *
 * Compute + persist the regression to the `security_regressions` cache (the
 * write that used to live on GET). Idempotent day-keyed UPSERT. Returns the
 * fresh result (or cached, if a concurrent request already warmed it).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const securityId = parseSecurityId(id);
  if (securityId === null) {
    return Response.json(
      { success: false, error: "Invalid security id" },
      { status: 400 }
    );
  }

  const benchmark = benchmarkOf(request);

  try {
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
