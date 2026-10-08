import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  applyTaxLotRecompute,
  rehearseTaxLotRecompute,
} from "@/lib/compute/tax-lot-recompute-summary";

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const confirmed =
      typeof body === "object" &&
      body !== null &&
      (body as { confirmRecompute?: unknown }).confirmRecompute === true;

    if (!confirmed) {
      const summary = rehearseTaxLotRecompute(db);
      return NextResponse.json({
        success: true,
        data: {
          requiresConfirmation: true,
          summary,
        },
      });
    }

    const result = applyTaxLotRecompute(db);

    return NextResponse.json({
      success: true,
      data: {
        requiresConfirmation: false,
        summary: result.summary,
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
