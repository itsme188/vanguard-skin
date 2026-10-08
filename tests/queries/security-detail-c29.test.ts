/**
 * Security hub disclosures (unit C29). Synthetic symbols and round numbers.
 *
 * qa: security-detail-positions--basis-and-gain-unknown-while-open-lot-row-below-carries-both
 *   The POSITIONS row printed a dash for basis and gain while the open lot
 *   below printed both. A caption now quotes what the lots carry; the row
 *   itself still does not adopt the figure.
 *
 * qa: security-detail-expired-held-option-hub--no-portfolio-data-empty-state-yet-scored-as-held
 *   An expired contract still on the latest holdings snapshot read "No
 *   portfolio data … Import holdings".
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeUnknownBasisLotNotes,
  getExpiredOptionSnapshotRows,
  getHoldingsBySecurity,
  getSecurityDetail,
} from "@/lib/queries/security-detail";
import { computeSecurityFactorShareView } from "@/lib/compute/factors";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const TAXABLE = 1; // seeded by migration 002
const ROTH = 2;

describe("computeUnknownBasisLotNotes", () => {
  const unknown = [{ account_id: TAXABLE, account_name: "Taxable", quantity: 100 }];

  it("quotes the same account's open lots for a position with no basis", () => {
    const lots = [
      { account_id: TAXABLE, quantity_remaining: 60, is_short: 0, adjusted_cost_basis: 1200 },
      { account_id: TAXABLE, quantity_remaining: 40, is_short: 0, adjusted_cost_basis: 800 },
      { account_id: ROTH, quantity_remaining: 10, is_short: 0, adjusted_cost_basis: 500 },
    ];
    expect(computeUnknownBasisLotNotes(unknown, lots)).toEqual([
      {
        accountId: TAXABLE,
        accountName: "Taxable",
        positionQty: 100,
        lotCount: 2,
        lotQty: 100,
        lotCostBasis: 2000,
      },
    ]);
  });

  it("no note when the account has no open lot, or only lots on the other side", () => {
    expect(computeUnknownBasisLotNotes(unknown, [])).toEqual([]);
    expect(
      computeUnknownBasisLotNotes(unknown, [
        { account_id: TAXABLE, quantity_remaining: 100, is_short: 1, adjusted_cost_basis: -2000 },
      ])
    ).toEqual([]);
  });

  it("a short position is matched to short-sale lots only", () => {
    const shortPos = [{ account_id: TAXABLE, account_name: "Taxable", quantity: -50 }];
    const lots = [
      { account_id: TAXABLE, quantity_remaining: 50, is_short: 1, adjusted_cost_basis: -900 },
      { account_id: TAXABLE, quantity_remaining: 20, is_short: 0, adjusted_cost_basis: 300 },
    ];
    expect(computeUnknownBasisLotNotes(shortPos, lots)).toEqual([
      { accountId: TAXABLE, accountName: "Taxable", positionQty: -50, lotCount: 1, lotQty: 50, lotCostBasis: -900 },
    ]);
  });

  it("ignores float-dust lots and positions that have a basis (none passed in)", () => {
    expect(
      computeUnknownBasisLotNotes(unknown, [
        { account_id: TAXABLE, quantity_remaining: 1e-9, is_short: 0, adjusted_cost_basis: 0 },
      ])
    ).toEqual([]);
    expect(computeUnknownBasisLotNotes([], [
      { account_id: TAXABLE, quantity_remaining: 100, is_short: 0, adjusted_cost_basis: 2000 },
    ])).toEqual([]);
  });
});

describe("getExpiredOptionSnapshotRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string, type: string, expiration: string | null): number {
    return Number(
      db
        .prepare(
          "INSERT INTO securities (symbol, name, security_type, multiplier, expiration_date) VALUES (?, ?, ?, ?, ?)"
        )
        .run(symbol, `${symbol} name`, type, type === "Option" ? 100 : 1, expiration).lastInsertRowid
    );
  }

  function seedHolding(securityId: number, accountId: number, quantity: number, asOf: string, key: string): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(accountId, securityId, quantity, 500, asOf, key);
  }

  it("returns the snapshot row of an expired contract that every position reader drops", () => {
    const expired = seedSecurity("AAA   200117P00050000", "Option", "2000-01-17");
    seedHolding(expired, TAXABLE, 5, "2000-01-31", "stmt-a");
    expect(getHoldingsBySecurity(db, expired)).toEqual([]);
    const rows = getExpiredOptionSnapshotRows(db, expired);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: TAXABLE, quantity: 5, as_of_date: "2000-01-31" });
    // The factor card already treats it as not held.
    expect(computeSecurityFactorShareView(db, expired).held).toBe(false);
    // And the hub read model carries it.
    expect(getSecurityDetail(db, expired)!.expiredOptionSnapshotRows).toHaveLength(1);
  });

  it("a legacy YYYYMMDD expiration in the past counts as expired too", () => {
    const expired = seedSecurity("AAA   200117C00050000", "Option", "20000117");
    seedHolding(expired, TAXABLE, 1, "2000-01-31", "stmt-b");
    expect(getExpiredOptionSnapshotRows(db, expired)).toHaveLength(1);
  });

  it("empty for a live contract, a stock, and an expired contract whose latest row is zero", () => {
    const live = seedSecurity("AAA   991217C00050000", "Option", "2999-12-17");
    seedHolding(live, TAXABLE, 2, "2026-01-02", "live");
    expect(getExpiredOptionSnapshotRows(db, live)).toEqual([]);

    const stock = seedSecurity("ZZZ", "Stock", null);
    seedHolding(stock, TAXABLE, 10, "2026-01-02", "stock");
    expect(getExpiredOptionSnapshotRows(db, stock)).toEqual([]);

    const closed = seedSecurity("AAA   200117P00040000", "Option", "2000-01-17");
    seedHolding(closed, TAXABLE, 3, "2000-01-15", "closed-1");
    seedHolding(closed, TAXABLE, 0, "2000-01-31", "closed-2");
    expect(getExpiredOptionSnapshotRows(db, closed)).toEqual([]);
  });

  it("is per account", () => {
    const expired = seedSecurity("AAA   200117P00030000", "Option", "2000-01-17");
    seedHolding(expired, TAXABLE, 5, "2000-01-31", "t");
    seedHolding(expired, ROTH, -2, "2000-01-31", "r");
    expect(getExpiredOptionSnapshotRows(db, expired).map((r) => r.quantity).sort()).toEqual([-2, 5]);
  });
});

describe("hub page wiring (source pin)", () => {
  const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  const between = (startNeedle: string, endNeedle: string): string => {
    const start = anchorIndex(page, startNeedle);
    return page.slice(start, anchorIndex(page, endNeedle, start + startNeedle.length));
  };

  it("the unknown-basis caption sits inside Positions and renders through privacy components", () => {
    const positions = between('<Section title="Positions">', "{/* Tax Lots */}");
    const caption = positions.slice(anchorIndex(positions, "unknownBasisLotNotes.map("));
    expect(caption).toContain("<Money value={note.lotCostBasis} />");
    expect(caption).toContain("<Shares value={note.lotQty} />");
    expect(caption).toContain("this row");
  });

  it("the short-over-long line sits above the lots table and renders through privacy components", () => {
    const lots = between("{/* Tax Lots */}", "{/* Closed Sales */}");
    const line = lots.slice(anchorIndex(lots, "lotSignMismatches.map("), anchorIndex(lots, "<table"));
    expect(line).toContain("<Shares value={Math.abs(m.positionQty)} />");
    expect(line).toContain("<Shares value={m.longLotQty} />");
    expect(line).toContain("<Count value={m.longLotCount} />");
    expect(line).toContain("not reconciled");
    expect(page).toContain("computeLotSignMismatches(positions, openTaxLots)");
  });

  it("an expired contract still on the snapshot replaces the import call to action", () => {
    const tail = page.slice(anchorIndex(page, "expiredOptionSnapshotRows.length > 0 && ("));
    expect(tail).toContain("awaiting a statement");
    const empty = tail.slice(anchorIndex(tail, "{/* Empty state"));
    expect(empty).toMatch(/\{expiredOptionSnapshotRows\.length === 0 &&\s+positions\.length === 0 &&/);
    expect(empty).toContain("Import Files");
  });

  // qa: security-detail-transcripts--option-contract-hub-offers-transcript-fetch-that-404s
  it("an option hub shows and refreshes the underlying's transcripts, never the contract's symbol", () => {
    expect(page).toContain("getTranscriptsForSecurity(db, optionUnderlying.id)");
    expect(page).toContain(
      "const transcriptSymbol = isOptionHub ? optionUnderlying?.symbol ?? null : security.symbol;"
    );
    const section = page.slice(anchorIndex(page, "{/* Transcripts. Always rendered"));
    expect(section).toContain("<TranscriptsRefreshButton ticker={transcriptSymbol} />");
    expect(section).not.toContain("<TranscriptsRefreshButton ticker={security.symbol} />");
    expect(section).toContain("<TranscriptList transcripts={shownTranscripts} />");
    expect(section).toContain("href={`/dashboard/security/${optionUnderlying.id}`}");
  });

  // qa: security-detail-upcoming-events--manual-confirmed-row-drops-slot-timing-and-confirmed-marker
  it("a hand-confirmed date carries a confirmed chip in Upcoming Events", () => {
    const events = between('<Section title="Upcoming Events" dense>', "{/* Sent earnings emails");
    expect(events).toMatch(/event\.date_status === "user_confirmed" && \(\s*<Chip/);
    expect(events).toMatch(/>\s*confirmed\s*<\/Chip>/);
  });
});
