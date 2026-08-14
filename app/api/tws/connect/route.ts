import { NextRequest, NextResponse } from "next/server";
import { assertAllowedTwsTarget, connectTws, getTwsStatus } from "@/lib/tws/client";
import { db } from "@/lib/db";
import { runAutoRefresh } from "@/lib/tws/auto-refresh";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));

    // Defense-in-depth (#35 Task 19, spec §G): validate the EFFECTIVE target
    // (caller-supplied value, falling back to the current config the same
    // way connectTws() merges it) before any connection is attempted. This
    // is independent of the route's auth class (`dual`, Task 18) — it caps
    // blast radius after any credential theft rather than gating who can call.
    const current = getTwsStatus();
    const targetHost = body.host ?? current.host;
    const targetPort = body.port ?? current.port;
    try {
      assertAllowedTwsTarget(targetHost, targetPort);
    } catch (err) {
      const message = err instanceof Error ? err.message : "TWS connect target not allowed";
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }

    const status = await connectTws({
      host: body.host,
      port: body.port,
      clientId: body.clientId,
    });

    // Fire auto-refresh pipeline after successful connection.
    // Runs asynchronously — client polls /api/tws/sync-status for progress.
    if (status.state === "connected") {
      runAutoRefresh(db).catch((err) => {
        console.error("[connect] Auto-refresh error:", err);
      });
    }

    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
