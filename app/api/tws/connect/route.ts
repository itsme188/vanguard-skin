import { NextRequest, NextResponse } from "next/server";
import { connectTws } from "@/lib/tws/client";
import { db } from "@/lib/db";
import { runAutoRefresh } from "@/lib/tws/auto-refresh";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
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
