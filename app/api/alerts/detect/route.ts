import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { detectAndFireAlerts } from "@/lib/alerts/detect";

export async function POST() {
  try {
    const result = detectAndFireAlerts(db);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
