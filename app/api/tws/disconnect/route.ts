import { NextResponse } from "next/server";
import { disconnectTws } from "@/lib/tws/client";

export async function POST() {
  try {
    const status = disconnectTws();
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
