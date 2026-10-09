import { NextRequest, NextResponse } from "next/server";
import { assertAllowedTwsTarget, connectTws, getTwsStatus } from "@/lib/tws/client";
import { db } from "@/lib/db";
import { runAutoRefresh } from "@/lib/tws/auto-refresh";

export async function POST(request: NextRequest) {
  try {
    // An empty or unparseable body means "connect with the current config".
    // A body that parsed to something other than an object (null, text, a
    // number, an array) is a caller mistake: say so plainly instead of
    // throwing on `body.host` or silently ignoring what was sent.
    const parsed: unknown = await request.json().catch(() => ({}));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json(
        { success: false, error: "body must be a JSON object" },
        { status: 400 },
      );
    }
    const body = parsed as { host?: unknown; port?: unknown; clientId?: unknown };

    // clientId: absent (or null) keeps the configured one; anything else must
    // be a whole number, zero included (0 is the TWS master client id).
    let clientId: number | undefined;
    if (body.clientId !== undefined && body.clientId !== null) {
      const raw = body.clientId;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        return NextResponse.json(
          { success: false, error: "clientId must be a whole number" },
          { status: 400 },
        );
      }
      clientId = raw;
    }

    // Defense-in-depth (#35 Task 19, spec §G): validate the EFFECTIVE target
    // (caller-supplied value, falling back to the current config the same
    // way connectTws() merges it) before any connection is attempted. This
    // is independent of the route's auth class (`dual`, Task 18) — it caps
    // blast radius after any credential theft rather than gating who can call.
    const current = getTwsStatus();
    const targetHost = body.host ?? current.host;
    const targetPort = body.port ?? current.port;
    try {
      // The body values are unchecked here on purpose: the assert refuses a
      // non-text host or a non-number port with a plain message.
      assertAllowedTwsTarget(targetHost as string, targetPort as number);
    } catch (err) {
      const message = err instanceof Error ? err.message : "TWS connect target not allowed";
      return NextResponse.json({ success: false, error: message }, { status: 400 });
    }

    // Connect with the RESOLVED target — not the raw body — so what was
    // validated is provably what connects. A raw body value like
    // {host: null} validates safely (falls back to targetHost above) but
    // would otherwise overwrite the live config with null via connectTws()'s
    // object-spread merge (an explicit key, even undefined/null, wins).
    // clientId follows the same rule: the key is sent only when the caller
    // supplied a checked value, so an omitted one never blanks the config.
    const status = await connectTws({
      host: targetHost as string,
      port: targetPort as number,
      ...(clientId !== undefined ? { clientId } : {}),
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
