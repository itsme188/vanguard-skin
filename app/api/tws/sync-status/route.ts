import { NextResponse } from "next/server";
import { getSyncState } from "@/lib/tws/sync-state";

export async function GET() {
  return NextResponse.json({ success: true, data: getSyncState() });
}
