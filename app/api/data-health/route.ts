import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getPriceFreshness,
  getAccountCoverage,
  getDataGaps,
  getCrossSourceDiscrepancies,
  getSnapshotReconciliation,
  getDataHealthSummary,
} from "@/lib/queries/data-health";

export async function GET() {
  try {
    const [
      summary,
      priceFreshness,
      accountCoverage,
      gaps,
      discrepancies,
      reconciliation,
    ] = [
      getDataHealthSummary(db),
      getPriceFreshness(db),
      getAccountCoverage(db),
      getDataGaps(db),
      getCrossSourceDiscrepancies(db),
      getSnapshotReconciliation(db),
    ];

    return NextResponse.json({
      success: true,
      summary,
      priceFreshness,
      accountCoverage,
      gaps,
      discrepancies,
      reconciliation,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
