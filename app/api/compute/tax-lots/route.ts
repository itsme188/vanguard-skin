import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { computeTaxLots } from "@/lib/compute/tax-lots";

export async function POST() {
  try {
    const result = computeTaxLots(db);

    return NextResponse.json({
      success: true,
      data: {
        lotsCreated: result.lotsCreated,
        salesProcessed: result.salesProcessed,
        totalRealizedGain: result.totalRealizedGain,
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
