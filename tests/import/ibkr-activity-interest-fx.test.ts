import { describe, it, expect } from "vitest";
import { parseIbkrActivity } from "@/lib/import/parsers/ibkr-activity";

// IBKR prints the Interest section as one block per currency: the native
// rows, a "Total" line in that currency, then a "Total in USD" line that
// carries the broker's own conversion of the block. The USD block ends with
// the grand "Total Interest in USD" line instead. Before 2026-09-03 the parser
// stored every row at its native amount, so a ₩36,461.73 debit-interest row
// landed in the ledger as −$36,461.73 (August 2026 statement).

const HEADER =
  "Statement,Header,Field Name,Field Value\n" +
  'Statement,Data,Period,"August 1, 2026 - August 31, 2026"\n';

const INTEREST_HDR = "Interest,Header,Currency,Account,Date,Description,Amount\n";

const KRW_BLOCK =
  "Interest,Data,KRW,U13643679,2026-08-05,KRW Debit Interest for Jul-2026,-36461.73\n" +
  "Interest,Data,Total,,,,-36461.73\n" +
  "Interest,Data,Total in USD,,,,-25.649733203\n";

const USD_BLOCK =
  "Interest,Data,USD,U13643679,2026-08-05,USD Credit Interest for Jul-2026,362.3\n" +
  "Interest,Data,USD,U13643679,2026-08-05,USD Borrow Fees for Jul-2026,-10.75\n" +
  "Interest,Data,USD,U13643679,2026-08-05,USD IBKR Managed Securities (SYEP) for Jul-2026,33.72\n" +
  "Interest,Data,Total,,,,385.27\n" +
  "Interest,Data,Total Interest in USD,,,,359.620266797\n";

function interestRows(csv: string) {
  return parseIbkrActivity(HEADER + csv, "test.csv").transactions.filter(
    (t) => t.type === "INTEREST"
  );
}

describe("ibkr-activity Interest section — non-USD blocks", () => {
  it("converts a KRW block to USD using the block's own Total-in-USD line", () => {
    const rows = interestRows(INTEREST_HDR + KRW_BLOCK + USD_BLOCK);

    // Four dated rows; the two "Total … in USD" summary lines are consumed,
    // never emitted as undated transactions.
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.tradeDate === "2026-08-05")).toBe(true);

    const krw = rows.find((r) => r.notes?.startsWith("KRW Debit Interest"))!;
    expect(krw).toBeTruthy();
    expect(krw.amount).toBeCloseTo(-25.649733203, 6);
    // Provenance: the note names the native figure that was converted.
    expect(krw.notes).toContain("KRW -36461.73");
    // Identity stays the printed native figure so a re-import of an older
    // statement dedupes against the row it already wrote.
    expect(krw.sourceKey).toBe(
      "ibkr:int:2026-08-05:-36461.73:KRW Debit Interest for Jul-2026"
    );
  });

  it("leaves USD rows untouched and never scales them by the grand total", () => {
    const rows = interestRows(INTEREST_HDR + KRW_BLOCK + USD_BLOCK);
    const usd = rows.filter((r) => r.notes?.startsWith("USD "));
    expect(usd.map((r) => r.amount)).toEqual([362.3, -10.75, 33.72]);
    expect(usd.map((r) => r.notes)).toEqual([
      "USD Credit Interest for Jul-2026",
      "USD Borrow Fees for Jul-2026",
      "USD IBKR Managed Securities (SYEP) for Jul-2026",
    ]);
  });

  it("splits a multi-row non-USD block pro rata by the block's Total-in-USD", () => {
    const eur =
      "Interest,Data,EUR,U13643679,2026-08-05,EUR Debit Interest for Jul-2026,-30\n" +
      "Interest,Data,EUR,U13643679,2026-08-05,EUR Credit Interest for Jul-2026,10\n" +
      "Interest,Data,Total,,,,-20\n" +
      "Interest,Data,Total in USD,,,,-22\n";
    const rows = interestRows(INTEREST_HDR + eur + USD_BLOCK);
    const debit = rows.find((r) => r.notes?.startsWith("EUR Debit"))!;
    const credit = rows.find((r) => r.notes?.startsWith("EUR Credit"))!;
    expect(debit.amount).toBeCloseTo(-33, 6); // -30 × (22/20)
    expect(credit.amount).toBeCloseTo(11, 6); // 10 × (22/20)
  });

  it("drops a non-USD block that has no Total-in-USD line and warns, rather than storing the native figure as dollars", () => {
    const orphan =
      "Interest,Data,KRW,U13643679,2026-08-05,KRW Debit Interest for Jul-2026,-36461.73\n" +
      "Interest,Data,Total,,,,-36461.73\n";
    const result = parseIbkrActivity(HEADER + INTEREST_HDR + orphan + USD_BLOCK, "test.csv");
    const rows = result.transactions.filter((t) => t.type === "INTEREST");
    expect(rows.map((r) => r.amount)).toEqual([362.3, -10.75, 33.72]);
    expect(result.warnings.some((w) => /KRW/.test(w) && /Total in USD/.test(w))).toBe(true);
  });

  it("is a no-op for a USD-only Interest section", () => {
    const rows = interestRows(INTEREST_HDR + USD_BLOCK);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.amount)).toEqual([362.3, -10.75, 33.72]);
    expect(rows.map((r) => r.sourceKey)).toEqual([
      "ibkr:int:2026-08-05:362.3:USD Credit Interest for Jul-2026",
      "ibkr:int:2026-08-05:-10.75:USD Borrow Fees for Jul-2026",
      "ibkr:int:2026-08-05:33.72:USD IBKR Managed Securities (SYEP) for Jul-2026",
    ]);
  });
});
