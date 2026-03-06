import { NextResponse } from "next/server";
import { getTwsStatus } from "@/lib/tws/client";

export async function GET() {
  return NextResponse.json({ success: true, data: getTwsStatus() });
}
