import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

export async function POST() {
  try {
    const result = computeDailyValuations(db);

    return NextResponse.json({
      success: true,
      data: {
        datesComputed: result.datesComputed,
        accountsProcessed: result.accountsProcessed,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
