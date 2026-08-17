import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findInkindCandidates,
  holdingsDeltaConfirms,
  applyInkindRepair,
  valuationForLeg,
  type InkindCandidate,
} from "@/scripts/repair-inkind-transfer-fmv";
import { computeRiskMetrics } from "@/lib/compute/risk";
import { computeTwr } from "@/lib/compute/twr";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";

// Mirrors tests/compute/donation-reconciliation.test.ts's fresh()/seed* idiom
// (same feature area) — migration 002 seeds accounts 1='Vanguard Taxable',
// 2='Vanguard Roth IRA', 3='IBKR'; migration 081 is the donations schema.
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

const ACCOUNT = 1;

let nextSecurityId = 1000;
function seedSecurity(db: Database.Database, symbol: string, opts?: { currency?: string; securityType?: string; multiplier?: number }): number {
  const id = nextSecurityId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, currency, security_type, multiplier) VALUES (?, ?, ?, ?, ?)`
  ).run(id, symbol, opts?.currency ?? "USD", opts?.securityType ?? null, opts?.multiplier ?? 1);
  return id;
}

let nextTxnId = 1;
interface TxnSeed {
  accountId: number;
  securityId: number;
  tradeDate: string;
  type: "TRANSFER_IN" | "TRANSFER_OUT";
  quantity: number;
  amount?: number | null;
  isExternalFlow?: number;
}
function seedTxn(db: Database.Database, t: TxnSeed): number {
  const id = nextTxnId++;
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, t.accountId, t.securityId, t.tradeDate, t.type, t.quantity, t.amount ?? 0, t.isExternalFlow ?? 1, `txn-${id}`);
  return id;
}

let nextDonationId = 1;
interface DonationSeed {
  securityId: number;
  quantity: number;
  fmvUsd: number;
  receivedDate: string;
}
function seedDonation(db: Database.Database, d: DonationSeed): number {
  const id = nextDonationId++;
  db.prepare(
    `INSERT INTO donations (id, source_key, kind, security_id, quantity, fmv_usd, received_date)
     VALUES (?, ?, 'stock', ?, ?, ?, ?)`
  ).run(id, `donation-${id}`, d.securityId, d.quantity, d.fmvUsd, d.receivedDate);
  return id;
}

function seedPrice(db: Database.Database, securityId: number, date: string, closePrice: number): void {
  db.prepare(`INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`).run(securityId, date, closePrice);
}

function seedCorporateAction(db: Database.Database, securityId: number, actionType: string, effectiveDate: string): void {
  db.prepare(
    `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator)
     VALUES (?, ?, ?, 2, 1)`
  ).run(securityId, actionType, effectiveDate);
}

function seedHolding(db: Database.Database, accountId: number, securityId: number, asOfDate: string, quantity: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `holding:${accountId}:${securityId}:${asOfDate}`);
}

function pairDonationCandidate(candidates: InkindCandidate[]): InkindCandidate | undefined {
  return candidates.find((c) => c.cls === "pair-donation");
}

beforeEach(() => {
  nextSecurityId = 1000;
  nextTxnId = 1;
  nextDonationId = 1;
});

describe("holdingsDeltaConfirms", () => {
  it("confirms when the position drops by at least the donation quantity across the month boundary", () => {
    const db = fresh();
    const secId = seedSecurity(db, "CONF");
    seedHolding(db, ACCOUNT, secId, "2026-03-31", 100);
    seedHolding(db, ACCOUNT, secId, "2026-04-30", 0);
    expect(holdingsDeltaConfirms(db, ACCOUNT, secId, "2026-04-15", 100)).toBe(true);
  });

  it("is unconfirmed when a boundary snapshot is missing entirely", () => {
    const db = fresh();
    const secId = seedSecurity(db, "NOBOUND");
    seedHolding(db, ACCOUNT, secId, "2026-04-30", 0); // no prior-month row
    expect(holdingsDeltaConfirms(db, ACCOUNT, secId, "2026-04-15", 100)).toBe(false);
  });

  it("is unconfirmed when the drop is smaller than the donation quantity", () => {
    const db = fresh();
    const secId = seedSecurity(db, "SHORTFALL");
    seedHolding(db, ACCOUNT, secId, "2026-03-31", 100);
    seedHolding(db, ACCOUNT, secId, "2026-04-30", 50); // only dropped 50, donation was 100
    expect(holdingsDeltaConfirms(db, ACCOUNT, secId, "2026-04-15", 100)).toBe(false);
  });
});

describe("findInkindCandidates / applyInkindRepair", () => {
  it("case 1: pair-donation happy path — links OUT+artifact, stamps amount, demotes the artifact leg", () => {
    const db = fresh();
    const secId = seedSecurity(db, "GIVE1");
    const donationId = seedDonation(db, { securityId: secId, quantity: 100, fmvUsd: 5000, receivedDate: "2026-04-15" });
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-15", type: "TRANSFER_OUT", quantity: 100 });
    const inLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-15", type: "TRANSFER_IN", quantity: 100 });
    seedHolding(db, ACCOUNT, secId, "2026-03-31", 100);
    seedHolding(db, ACCOUNT, secId, "2026-04-30", 0);

    const candidates = findInkindCandidates(db);
    const pair = pairDonationCandidate(candidates);
    expect(pair).toBeDefined();
    expect(pair).toMatchObject({
      cls: "pair-donation",
      legId: outLegId,
      artifactLegId: inLegId,
      donationId,
      proposedAmount: 5000,
    });

    const result = applyInkindRepair(db, candidates);
    expect(result).toEqual({ applied: 1, skipped: 0 });

    const outLink = db.prepare(`SELECT role FROM donation_leg_links WHERE transaction_id = ?`).get(outLegId) as { role: string };
    const artifactLink = db.prepare(`SELECT role FROM donation_leg_links WHERE transaction_id = ?`).get(inLegId) as { role: string };
    expect(outLink.role).toBe("out");
    expect(artifactLink.role).toBe("routing_artifact");

    const outTxn = db.prepare(`SELECT amount FROM transactions WHERE id = ?`).get(outLegId) as { amount: number };
    expect(outTxn.amount).toBe(5000);

    const inTxn = db.prepare(`SELECT is_external_flow, notes FROM transactions WHERE id = ?`).get(inLegId) as {
      is_external_flow: number;
      notes: string | null;
    };
    expect(inTxn.is_external_flow).toBe(0);
    expect(inTxn.notes).toContain("routing artifact");
  });

  it("case 2: same-day exact match on a single (non-pair) leg chooses fmv_usd over any price lookup", () => {
    const db = fresh();
    const secId = seedSecurity(db, "SAME2");
    const donationId = seedDonation(db, { securityId: secId, quantity: 50, fmvUsd: 2500, receivedDate: "2026-05-01" });
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-01", type: "TRANSFER_OUT", quantity: 50 });
    // A price row exists too — if the exact-date-price fallback were used by
    // mistake it would produce 50*99=4950, not the donation's fmv_usd 2500.
    seedPrice(db, secId, "2026-05-01", 99);

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ cls: "fmv-stamp", legId, proposedAmount: 2500 });
    expect(candidates[0].donationId).toBeUndefined();
  });

  it("case 3: a 1-day gap from the donation's received_date falls to the exact-leg-date price", () => {
    const db = fresh();
    const secId = seedSecurity(db, "GAP3");
    seedDonation(db, { securityId: secId, quantity: 20, fmvUsd: 999999, receivedDate: "2026-05-10" });
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-11", type: "TRANSFER_OUT", quantity: 20 });
    seedPrice(db, secId, "2026-05-11", 55);

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ cls: "fmv-stamp", legId, proposedAmount: 20 * 55 });
  });

  it("case 4: no exact-date price row (with a donation match at a gap) -> anomaly, unpriceable", () => {
    const db = fresh();
    const secId = seedSecurity(db, "NOPRICE4");
    seedDonation(db, { securityId: secId, quantity: 20, fmvUsd: 1000, receivedDate: "2026-05-10" });
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-11", type: "TRANSFER_OUT", quantity: 20 });
    // No price seeded for 2026-05-11.

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].cls).toBe("anomaly");
    expect(candidates[0].legId).toBe(legId);
    expect(candidates[0].reason).toMatch(/unpriceable/);
  });

  it("case 5: a non-USD security is always an anomaly, even with an exact-date price available", () => {
    const db = fresh();
    const secId = seedSecurity(db, "EURJ", { currency: "EUR" });
    // Lone journal leg, no donation at all.
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-01", type: "TRANSFER_IN", quantity: 10 });
    seedPrice(db, secId, "2026-06-01", 20);

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].cls).toBe("anomaly");
    expect(candidates[0].legId).toBe(legId);
    expect(candidates[0].reason).toMatch(/USD/);
  });

  it("case 6: a split effective on/after the leg date makes the price basis ambiguous -> anomaly", () => {
    const db = fresh();
    const secId = seedSecurity(db, "SPLIT6");
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 10 });
    seedPrice(db, secId, "2026-06-01", 20); // present, but must be ignored
    seedCorporateAction(db, secId, "SPLIT", "2026-06-01"); // effective_date >= legDate

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].cls).toBe("anomaly");
    expect(candidates[0].legId).toBe(legId);
    expect(candidates[0].reason).toMatch(/split/i);
  });

  it("case 6b: a split effective BEFORE the leg date does not block pricing", () => {
    const db = fresh();
    const secId = seedSecurity(db, "SPLIT6B");
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-10", type: "TRANSFER_OUT", quantity: 10 });
    seedPrice(db, secId, "2026-06-10", 20);
    seedCorporateAction(db, secId, "SPLIT", "2026-06-01"); // strictly before the leg date

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ cls: "fmv-stamp", legId, proposedAmount: 200 });
  });

  it("case 7: holdings-delta unconfirmed (no holdings rows at all) blocks a pair-donation -> anomaly, never applied", () => {
    const db = fresh();
    const secId = seedSecurity(db, "NODELTA7");
    const donationId = seedDonation(db, { securityId: secId, quantity: 100, fmvUsd: 5000, receivedDate: "2026-04-15" });
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-15", type: "TRANSFER_OUT", quantity: 100 });
    const inLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-15", type: "TRANSFER_IN", quantity: 100 });
    // No holdings rows seeded at all — unconfirmed by construction.

    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ cls: "anomaly", legId: outLegId, artifactLegId: inLegId, donationId });
    expect(candidates[0].reason).toMatch(/holdings-delta unconfirmed/);
    expect(candidates[0].proposedAmount).toBeUndefined();

    const result = applyInkindRepair(db, candidates);
    expect(result).toEqual({ applied: 0, skipped: 1 });
    const outTxn = db.prepare(`SELECT amount FROM transactions WHERE id = ?`).get(outLegId) as { amount: number };
    expect(outTxn.amount).toBe(0);
    const linkCount = db.prepare(`SELECT COUNT(*) AS n FROM donation_leg_links`).get() as { n: number };
    expect(linkCount.n).toBe(0);
  });

  it("case 8: fmv-stamp prices a lone unmatched same-day journal pair via the price road, both legs independently", () => {
    const db = fresh();
    const secId = seedSecurity(db, "JOURNAL8");
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-01", type: "TRANSFER_OUT", quantity: 30 });
    const inLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-01", type: "TRANSFER_IN", quantity: 30 });
    seedPrice(db, secId, "2026-07-01", 12);

    const candidates = findInkindCandidates(db);
    const fmvStampCandidates = candidates.filter((c) => c.cls === "fmv-stamp");
    expect(fmvStampCandidates).toHaveLength(2);
    const byLegId = new Map(fmvStampCandidates.map((c) => [c.legId, c]));
    expect(byLegId.get(outLegId)?.proposedAmount).toBe(360);
    expect(byLegId.get(inLegId)?.proposedAmount).toBe(360);

    const result = applyInkindRepair(db, candidates);
    expect(result.applied).toBe(2);

    const outTxn = db.prepare(`SELECT amount, source_key FROM transactions WHERE id = ?`).get(outLegId) as {
      amount: number;
      source_key: string;
    };
    expect(outTxn.amount).toBe(360);
    expect(outTxn.source_key).toBe(`txn-${outLegId}`); // untouched
  });

  it("case 9: idempotence — a second findInkindCandidates after apply finds zero writable candidates", () => {
    const db = fresh();
    const secId1 = seedSecurity(db, "IDEM1");
    seedDonation(db, { securityId: secId1, quantity: 100, fmvUsd: 5000, receivedDate: "2026-04-15" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId1, tradeDate: "2026-04-15", type: "TRANSFER_OUT", quantity: 100 });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId1, tradeDate: "2026-04-15", type: "TRANSFER_IN", quantity: 100 });
    seedHolding(db, ACCOUNT, secId1, "2026-03-31", 100);
    seedHolding(db, ACCOUNT, secId1, "2026-04-30", 0);

    const secId2 = seedSecurity(db, "IDEM2");
    seedDonation(db, { securityId: secId2, quantity: 50, fmvUsd: 2500, receivedDate: "2026-05-01" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId2, tradeDate: "2026-05-01", type: "TRANSFER_OUT", quantity: 50 });

    const first = findInkindCandidates(db);
    const writableFirst = first.filter((c) => c.cls === "pair-donation" || c.cls === "fmv-stamp");
    expect(writableFirst).toHaveLength(2);

    applyInkindRepair(db, first);

    const second = findInkindCandidates(db);
    const writableSecond = second.filter((c) => c.cls === "pair-donation" || c.cls === "fmv-stamp");
    expect(writableSecond).toHaveLength(0);
  });

  it("case 10: a donation with no candidate legs at all lands in legs-missing, and is never inserted", () => {
    const db = fresh();
    const secId = seedSecurity(db, "MISSING10");
    const donationId = seedDonation(db, { securityId: secId, quantity: 15, fmvUsd: 750, receivedDate: "2026-08-01" });

    const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number }).n;
    const candidates = findInkindCandidates(db);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ cls: "legs-missing", donationId });
    expect(candidates[0].legId).toBeUndefined();

    const result = applyInkindRepair(db, candidates);
    expect(result).toEqual({ applied: 0, skipped: 1 });
    const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM transactions`).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });

  it("groups duplicate-suspect legs and ambiguous donation matches as anomalies", () => {
    const db = fresh();
    const dupSec = seedSecurity(db, "DUPE11");
    const legA = seedTxn(db, { accountId: ACCOUNT, securityId: dupSec, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 0 });
    seedTxn(db, { accountId: ACCOUNT, securityId: dupSec, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 4550 });

    const ambigSec = seedSecurity(db, "AMBIG11");
    seedDonation(db, { securityId: ambigSec, quantity: 40, fmvUsd: 2000, receivedDate: "2026-07-01" });
    seedDonation(db, { securityId: ambigSec, quantity: 40, fmvUsd: 2000, receivedDate: "2026-07-02" });
    seedTxn(db, { accountId: ACCOUNT, securityId: ambigSec, tradeDate: "2026-07-01", type: "TRANSFER_OUT", quantity: 40 });
    seedTxn(db, { accountId: ACCOUNT, securityId: ambigSec, tradeDate: "2026-07-02", type: "TRANSFER_OUT", quantity: 40 });

    const candidates = findInkindCandidates(db);
    const anomalies = candidates.filter((c) => c.cls === "anomaly");
    expect(anomalies.some((c) => c.legId === legA)).toBe(true);
    expect(anomalies.filter((c) => c.donationId != null).length).toBe(2); // the two ambiguous donations
  });

  it("CRITICAL: a duplicate-suspect leg (amount=0, priced sibling exists) never gets a writable stamp — anomaly only", () => {
    const db = fresh();
    const dupSec = seedSecurity(db, "DUPEWRITE12");
    // Same (account,date,security,qty,type) — differing amounts — is exactly
    // findDuplicateSuspects' definition. legA's amount=0 makes it look, on
    // its own, like an ordinary unstamped in-kind leg; a price row on its
    // exact trade date would let the fmv-stamp sweep price it if the leg
    // isn't excluded from that sweep.
    const legA = seedTxn(db, { accountId: ACCOUNT, securityId: dupSec, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 0 });
    seedTxn(db, { accountId: ACCOUNT, securityId: dupSec, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 4550 });
    seedPrice(db, dupSec, "2026-06-01", 999); // would price legA if not excluded from the sweep

    const candidates = findInkindCandidates(db);
    const writableForLegA = candidates.filter(
      (c) => c.legId === legA && (c.cls === "pair-donation" || c.cls === "fmv-stamp")
    );
    expect(writableForLegA).toHaveLength(0);
    const anomalyForLegA = candidates.find((c) => c.cls === "anomaly" && c.legId === legA);
    expect(anomalyForLegA).toBeDefined();

    const result = applyInkindRepair(db, candidates);
    const legATxn = db.prepare(`SELECT amount FROM transactions WHERE id = ?`).get(legA) as { amount: number };
    expect(legATxn.amount).toBe(0);
    expect(result.applied).toBe(0); // legA is the only leg with amount=0 in this fixture
  });

  it("CRITICAL: ambiguous-match candidate legs never get a writable stamp — anomaly only", () => {
    const db = fresh();
    const ambigSec = seedSecurity(db, "AMBIGWRITE12");
    seedDonation(db, { securityId: ambigSec, quantity: 40, fmvUsd: 2000, receivedDate: "2026-07-01" });
    seedDonation(db, { securityId: ambigSec, quantity: 40, fmvUsd: 2000, receivedDate: "2026-07-02" });
    const legA = seedTxn(db, { accountId: ACCOUNT, securityId: ambigSec, tradeDate: "2026-07-01", type: "TRANSFER_OUT", quantity: 40 });
    const legB = seedTxn(db, { accountId: ACCOUNT, securityId: ambigSec, tradeDate: "2026-07-02", type: "TRANSFER_OUT", quantity: 40 });
    // Price rows on both exact trade dates — would price both legs via the
    // fmv-stamp fallback if they weren't excluded from the sweep as
    // ambiguous-match candidates.
    seedPrice(db, ambigSec, "2026-07-01", 55);
    seedPrice(db, ambigSec, "2026-07-02", 56);

    const candidates = findInkindCandidates(db);
    for (const legId of [legA, legB]) {
      const writable = candidates.filter((c) => c.legId === legId && (c.cls === "pair-donation" || c.cls === "fmv-stamp"));
      expect(writable).toHaveLength(0);
    }
    const anomaliesWithDonation = candidates.filter((c) => c.cls === "anomaly" && c.donationId != null);
    expect(anomaliesWithDonation).toHaveLength(2);

    const result = applyInkindRepair(db, candidates);
    expect(result.applied).toBe(0);
    for (const legId of [legA, legB]) {
      const txn = db.prepare(`SELECT amount FROM transactions WHERE id = ?`).get(legId) as { amount: number };
      expect(txn.amount).toBe(0);
    }
  });
});

describe("valuationForLeg", () => {
  it("scales an option leg's price by the multiplier through marketValue, never bare price*qty", () => {
    const db = fresh();
    const secId = seedSecurity(db, "OPT12", { securityType: "option", multiplier: 100 });
    seedPrice(db, secId, "2026-06-15", 3.5);
    const result = valuationForLeg(db, { securityId: secId, legDate: "2026-06-15", quantity: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.amount).toBe(5 * 3.5 * 100);
  });

  it("scales a bond leg's price by /100 par through marketValue", () => {
    const db = fresh();
    const secId = seedSecurity(db, "BOND12", { securityType: "bond" });
    seedPrice(db, secId, "2026-06-15", 98.5);
    const result = valuationForLeg(db, { securityId: secId, legDate: "2026-06-15", quantity: 10000 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.amount).toBe((10000 * 98.5) / 100);
  });
});

// ─── Spec §11 metric before/after: TWR, volatility, and attribution all
// carry a fake single-day loss before repair and normalize after. ───────

describe("metric before/after (spec §11)", () => {
  function addDays(date: string, n: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Builds a 31-day fixture: a single account/security portfolio flat at
  // $100,000 that permanently drops to $90,000 on the donation day
  // (2026-02-16, day index 15) — the FMV of a 1,000-share stock donation —
  // and stays flat afterward. Pre-repair the OUT/IN legs both carry
  // amount=0 (the legacy convention this script fixes), so the drop reads
  // as a real one-day market loss to every flow-consuming reader.
  function buildFixture(db: Database.Database): { donationId: number; outLegId: number; inLegId: number; secId: number } {
    const secId = seedSecurity(db, "METRIC13");
    const START = "2026-02-01";
    const DROP_DATE = "2026-02-16"; // day index 15
    const DAYS = 31;

    for (let i = 0; i < DAYS; i++) {
      const date = addDays(START, i);
      const totalValue = i < 15 ? 100_000 : 90_000;
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
         VALUES (?, ?, 0, ?, ?)`
      ).run(ACCOUNT, date, totalValue, totalValue);
      // Alternating benchmark series so the beta regression has non-zero
      // benchmark variance (a perfectly flat benchmark makes beta undefined).
      const benchPrice = i % 2 === 0 ? 400 : 401;
      db.prepare(`INSERT INTO benchmark_prices (symbol, date, close_price) VALUES ('SPY', ?, ?)`).run(date, benchPrice);
    }

    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, deposits_withdrawals, source)
       VALUES (?, '2026-01-31', 100000, 0, 'canonical')`
    ).run(ACCOUNT);
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, deposits_withdrawals, source)
       VALUES (?, '2026-02-28', 90000, 0, 'canonical')`
    ).run(ACCOUNT);

    const donationId = seedDonation(db, { securityId: secId, quantity: 1000, fmvUsd: 10_000, receivedDate: DROP_DATE });
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: DROP_DATE, type: "TRANSFER_OUT", quantity: 1000 });
    const inLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: DROP_DATE, type: "TRANSFER_IN", quantity: 1000 });
    seedHolding(db, ACCOUNT, secId, "2026-01-31", 1000);
    seedHolding(db, ACCOUNT, secId, "2026-02-28", 0);

    return { donationId, outLegId, inLegId, secId };
  }

  it("TWR shows the fake loss before repair and normalizes to the hand-computed value after", () => {
    const db = fresh();
    buildFixture(db);

    const before = computeTwr(db, { accountId: ACCOUNT });
    expect(before).not.toBeNull();
    // Modified Dietz with vStart=100000, vEnd=90000, and a $0 flow: exactly -10%.
    expect(before!.totalReturn).toBeCloseTo(-0.1, 9);

    const candidates = findInkindCandidates(db);
    const applyResult = applyInkindRepair(db, candidates);
    expect(applyResult.applied).toBe(1);

    const after = computeTwr(db, { accountId: ACCOUNT });
    expect(after).not.toBeNull();
    // With the $10,000 flow now recognized, the Modified Dietz numerator
    // (vEnd - vStart - totalCF) = (90000 - 100000 - (-10000)) = 0 exactly.
    expect(after!.totalReturn).toBeCloseTo(0, 9);
    expect(Math.abs(after!.totalReturn)).toBeLessThan(Math.abs(before!.totalReturn));
  });

  it("volatility is inflated by the fake loss day before repair and drops to the no-donation baseline (0) after", () => {
    const db = fresh();
    buildFixture(db);

    const before = computeRiskMetrics(db, { accountIds: [ACCOUNT] });
    expect(before.volatility).not.toBeNull();
    expect(before.volatility!).toBeGreaterThan(0.01); // clearly inflated by the one fake -10% day

    const candidates = findInkindCandidates(db);
    applyInkindRepair(db, candidates);

    const after = computeRiskMetrics(db, { accountIds: [ACCOUNT] });
    // Every day is flat once the donation day's drop is flow-adjusted away —
    // a perfectly clean (zero) volatility baseline.
    expect(after.volatility).toBeCloseTo(0, 9);
    expect(after.volatility!).toBeLessThan(before.volatility!);
  });

  it("attribution misattributes the drop to alpha before repair and stops charging it after", () => {
    const db = fresh();
    buildFixture(db);

    const beforeAttribution = computePeriodAttribution(db, ACCOUNT, "2026-02-01", "2026-03-03", "SPY");
    // Before repair, the whole -10% fake-loss day has no offsetting flow, so
    // it flows straight into the alpha residual (portfolioReturn - betaContribution)
    // instead of being recognized as a donation.
    expect(beforeAttribution.betaVsAlpha.alphaContribution).toBeLessThan(-0.05);

    const candidates = findInkindCandidates(db);
    applyInkindRepair(db, candidates);

    const afterAttribution = computePeriodAttribution(db, ACCOUNT, "2026-02-01", "2026-03-03", "SPY");
    // Every daily return is exactly 0 post-repair (the drop is fully
    // explained by the flow), so both the beta regression and alpha
    // collapse to exactly 0 — attribution no longer charges anything to the
    // portfolio's stock-picking skill for a day that was really a gift.
    expect(afterAttribution.betaVsAlpha.alphaContribution).toBeCloseTo(0, 9);
    expect(Math.abs(afterAttribution.betaVsAlpha.alphaContribution)).toBeLessThan(
      Math.abs(beforeAttribution.betaVsAlpha.alphaContribution)
    );
  });

  it("fetchNetFlowsByDate gains exactly one date after repair", () => {
    const db = fresh();
    buildFixture(db);

    const before = fetchNetFlowsByDate(db, undefined, "0000-00-00", "9999-12-31");
    expect(before).toHaveLength(0); // both legs amount=0 -> net=0 -> filtered by HAVING != 0

    const candidates = findInkindCandidates(db);
    applyInkindRepair(db, candidates);

    const after = fetchNetFlowsByDate(db, undefined, "0000-00-00", "9999-12-31");
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ date: "2026-02-16", net: -10_000 });
  });
});
