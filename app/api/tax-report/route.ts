import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateTaxReport, generateForm8949CSV, generateTXF } from "@/lib/compute/tax-report";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const yearParam = searchParams.get("year");
    const format = searchParams.get("format") ?? "json";

    const year = yearParam ? Number(yearParam) : new Date().getFullYear();

    if (isNaN(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { success: false, error: "Invalid year" },
        { status: 400 }
      );
    }

    const report = generateTaxReport(db, year);

    if (format === "csv") {
      const csv = generateForm8949CSV(report);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="form-8949-${year}.csv"`,
        },
      });
    }

    if (format === "txf") {
      const txf = generateTXF(report);
      return new NextResponse(txf, {
        headers: {
          "Content-Type": "application/x-tax-exchange",
          "Content-Disposition": `attachment; filename="tax-report-${year}.txf"`,
        },
      });
    }

    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
