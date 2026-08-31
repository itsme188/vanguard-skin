import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateTaxReport,
  generateForm8949CSV,
  generateTXF,
  buildTaxReportFilename,
} from "@/lib/compute/tax-report";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const yearParam = searchParams.get("year");
    const format = searchParams.get("format") ?? "json";
    // ?account=<accounts.name> mirrors the Tax Lots page filter. Parse only —
    // the scoping itself lives in generateTaxReport (single source of truth
    // for which rows the card, the CSV and the TXF all describe).
    const accountName = searchParams.get("account")?.trim() || null;

    const year = yearParam ? Number(yearParam) : new Date().getFullYear();

    if (isNaN(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { success: false, error: "Invalid year" },
        { status: 400 }
      );
    }

    const report = generateTaxReport(db, year, { accountName });

    if (format === "csv") {
      const csv = generateForm8949CSV(report);
      // Filename: buildTaxReportFilename appends "-NOT-FOR-FILING" unless
      // report.filingReady (broker-acceptance marker covers this account and
      // year) and carries the account slug when scoped — single-sourced with
      // TaxReportCard's client-side download name.
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${buildTaxReportFilename("csv", year, report.filingReady, report.accountName)}"`,
        },
      });
    }

    if (format === "txf") {
      const txf = generateTXF(report);
      // Filename: buildTaxReportFilename appends "-NOT-FOR-FILING" unless
      // report.filingReady (broker-acceptance marker covers this account and
      // year) and carries the account slug when scoped — single-sourced with
      // TaxReportCard's client-side download name.
      return new NextResponse(txf, {
        headers: {
          "Content-Type": "application/x-tax-exchange",
          "Content-Disposition": `attachment; filename="${buildTaxReportFilename("txf", year, report.filingReady, report.accountName)}"`,
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
