import { NextRequest, NextResponse } from "next/server";
import { connectTws } from "@/lib/tws/client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const status = await connectTws({
      host: body.host,
      port: body.port,
      clientId: body.clientId,
    });
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
