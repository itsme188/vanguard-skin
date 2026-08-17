/**
 * Parser for donor-advised fund (DAF) yearly contribution export CSVs.
 * Format: type,frequency,amount,currency,USD amount,currency valuation,
 *         created at,received at,completed at
 *
 * Produces ParsedDonation records. This parser is DB-free (pure, matching
 * the rest of lib/import/parsers) — resolving symbolRaw to a securities row
 * happens in the engine at preview/commit time (Task 5), not here.
 */

import Papa from "papaparse";
import type { ParsedImportResult, ParsedDonation } from "../types";

interface DafContributionRow {
  type?: string;
  frequency?: string;
  amount?: string;
  currency?: string;
  "USD amount"?: string;
  "currency valuation"?: string;
  "created at"?: string;
  "received at"?: string;
  "completed at"?: string;
}

// Reject comma-bearing numerics (same rationale as canonical-csv.ts's
// parseStrictNumber, not exported from there so replicated here):
// parseFloat("1,234.56") silently truncates to 1 instead of failing.
function parseStrictNumber(s: string | undefined): number {
  if (!s) return NaN;
  const trimmed = s.trim();
  if (!trimmed) return NaN;
  if (trimmed.includes(",")) return NaN;
  return parseFloat(trimmed);
}

/**
 * Converts a verbatim provider UTC timestamp ("YYYY-MM-DD HH:MM:SS +0000")
 * to its ET calendar date (YYYY-MM-DD). Returns null if the string doesn't
 * match the expected shape. Exported for tests.
 */
export function etDateFromUtcTimestamp(ts: string): string | null {
  const m = ts.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0000$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA gives YYYY-MM-DD directly
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function parseDafContributions(
  content: string,
  filename: string
): ParsedImportResult {
  const parsed = Papa.parse<DafContributionRow>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const e of parsed.errors) {
    errors.push(`CSV parse error at row ${e.row}: ${e.message}`);
  }

  interface Interim {
    donation: ParsedDonation;
    baseKey: string;
  }
  const interim: Interim[] = [];
  const baseKeyCounts = new Map<string, number>();

  for (const row of parsed.data) {
    const type = row.type?.trim();
    if (!type) continue;

    let kind: "stock" | "cash";
    if (type === "Stock") {
      kind = "stock";
    } else if (type === "Bank transfer") {
      kind = "cash";
    } else {
      warnings.push(`Skipped donation row: unrecognized type "${type}"`);
      continue;
    }

    const fmvUsd = parseStrictNumber(row["USD amount"]);
    if (!Number.isFinite(fmvUsd) || fmvUsd <= 0) {
      warnings.push(
        `Skipped donation row (${type}, received ${row["received at"]?.trim() || "unknown date"}): non-positive or missing USD amount`
      );
      continue;
    }

    const receivedRaw = row["received at"]?.trim();
    const receivedDate = receivedRaw ? etDateFromUtcTimestamp(receivedRaw) : null;
    if (!receivedDate) {
      warnings.push(
        `Skipped donation row (${type}): missing or unparsable "received at" timestamp`
      );
      continue;
    }

    let symbolRaw: string | null = null;
    let quantity: number | null = null;
    if (kind === "stock") {
      symbolRaw = row.currency?.trim().toUpperCase() || null;
      if (!symbolRaw) {
        warnings.push(
          `Skipped donation row: stock donation missing symbol ("currency" column)`
        );
        continue;
      }
      const qty = parseStrictNumber(row.amount);
      if (!Number.isFinite(qty)) {
        warnings.push(
          `Skipped donation row (${symbolRaw}): stock donation missing/invalid quantity ("amount" column)`
        );
        continue;
      }
      quantity = qty;
    }

    const createdRaw = row["created at"]?.trim();
    const createdAtRaw = createdRaw ? createdRaw : null;
    const createdDate = createdAtRaw ? etDateFromUtcTimestamp(createdAtRaw) : null;

    const completedRaw = row["completed at"]?.trim();
    const completedDate = completedRaw ? etDateFromUtcTimestamp(completedRaw) : null;

    const valuationRaw = row["currency valuation"]?.trim();
    const parsedValuation = valuationRaw ? parseStrictNumber(valuationRaw) : NaN;
    const unitValuation = Number.isFinite(parsedValuation) ? parsedValuation : null;

    const symbolOrUSD = kind === "stock" ? (symbolRaw as string) : "USD";
    const qtyOrAmount = kind === "stock" ? String(quantity) : String(fmvUsd);
    const baseKey = `daf:contribution:${receivedDate}:${symbolOrUSD}:${qtyOrAmount}:${createdAtRaw ?? ""}`;

    baseKeyCounts.set(baseKey, (baseKeyCounts.get(baseKey) ?? 0) + 1);

    interim.push({
      donation: {
        sourceKey: baseKey, // finalized in the second pass below
        kind,
        symbolRaw,
        quantity,
        fmvUsd,
        unitValuation,
        createdDate,
        receivedDate,
        completedDate,
        createdAtRaw,
      },
      baseKey,
    });
  }

  // Second pass: rows with no "created at" whose (date, symbol, qty|amount)
  // identity collides with another such row can't be told apart by
  // source_key alone. Keep them (the engine blocks them at commit — Task 5)
  // but flag with a "null-created" marker + a warning so the ambiguity is
  // visible in preview.
  const groupOccurrence = new Map<string, number>();
  const donations: ParsedDonation[] = [];
  for (const { donation, baseKey } of interim) {
    if (donation.createdAtRaw === null && (baseKeyCounts.get(baseKey) ?? 0) > 1) {
      const n = (groupOccurrence.get(baseKey) ?? 0) + 1;
      groupOccurrence.set(baseKey, n);
      donation.sourceKey = `${baseKey}null-created:${n}`;
      warnings.push(
        `Donation ${donation.symbolRaw ?? "USD"} received ${donation.receivedDate}: missing "created at" — identity key collides with another row in this file, flagged for manual review`
      );
    }
    donations.push(donation);
  }

  return {
    sourceType: "daf-contributions",
    sourceName: filename,
    transactions: [],
    securities: [],
    holdings: [],
    prices: [],
    snapshots: [],
    corporateActions: [],
    donations,
    errors,
    warnings,
  };
}
