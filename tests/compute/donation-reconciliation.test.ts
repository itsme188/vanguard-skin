import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  reconcileDonations,
  withinBusinessDays,
  type TransferLegRow,
} from "@/lib/compute/donation-reconciliation";

// Mirrors tests/mutations/donation-links.test.ts's fresh()/seed* idiom (same
// feature, sibling task) — migration 002 seeds accounts 1='Vanguard Taxable',
// 2='Vanguard Roth IRA', 3='IBKR'; migration 081 is the donations schema.
function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

let nextSecurityId = 1000;
function seedSecurity(db: Database.Database, symbol: string, currency?: string): number {
  const id = nextSecurityId++;
  if (currency) {
    db.prepare("INSERT INTO securities (id, symbol, currency) VALUES (?, ?, ?)").run(id, symbol, currency);
  } else {
    db.prepare("INSERT INTO securities (id, symbol) VALUES (?, ?)").run(id, symbol);
  }
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
}
function seedTxn(db: Database.Database, t: TxnSeed): number {
  const id = nextTxnId++;
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, t.accountId, t.securityId, t.tradeDate, t.type, t.quantity, t.amount ?? 0, `txn-${id}`);
  return id;
}

let nextDonationId = 1;
interface DonationSeed {
  kind?: "stock" | "cash";
  securityId: number | null;
  quantity: number | null;
  fmvUsd?: number;
  receivedDate: string;
  reversedDate?: string | null;
}
function seedDonation(db: Database.Database, d: DonationSeed): number {
  const id = nextDonationId++;
  db.prepare(
    `INSERT INTO donations (id, source_key, kind, security_id, quantity, fmv_usd, received_date, reversed_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `donation-${id}`,
    d.kind ?? "stock",
    d.securityId,
    d.quantity,
    d.fmvUsd ?? 1000,
    d.receivedDate,
    d.reversedDate ?? null
  );
  return id;
}

function linkLeg(db: Database.Database, donationId: number, transactionId: number, role: "out" | "routing_artifact") {
  db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, ?)").run(
    donationId,
    transactionId,
    role
  );
}

const ACCOUNT = 1;

describe("withinBusinessDays", () => {
  it("counts weekdays only, skipping weekends (documented approximation — holidays ignored)", () => {
    // 2026-03-04 is a Wednesday. +4 business days (Thu,Fri,[Sat,Sun skip],Mon,Tue)
    // crosses a weekend and lands on 2026-03-10 (Tuesday).
    expect(withinBusinessDays("2026-03-04", "2026-03-10", 5)).toBe(true);
    // +6 business days lands on 2026-03-12 (Thursday) — outside a ±5 window.
    expect(withinBusinessDays("2026-03-04", "2026-03-12", 5)).toBe(false);
    // Symmetric: works with the leg date first too.
    expect(withinBusinessDays("2026-03-10", "2026-03-04", 5)).toBe(true);
    // Exact same date is always within any window.
    expect(withinBusinessDays("2026-03-04", "2026-03-04", 0)).toBe(true);
  });

  it("is genuinely order-independent even when an endpoint falls on a weekend", () => {
    // 2026-08-10 is a Monday, 2026-08-15 is the following Saturday — 4 business
    // days apart (Tue,Wed,Thu,Fri). Swapping call order must not change the
    // business-day distance just because the weekend endpoint moves from the
    // "end" to the "start" of the walk.
    expect(withinBusinessDays("2026-08-10", "2026-08-15", 4)).toBe(
      withinBusinessDays("2026-08-15", "2026-08-10", 4)
    );
    expect(withinBusinessDays("2026-08-10", "2026-08-15", 4)).toBe(true);
    expect(withinBusinessDays("2026-08-15", "2026-08-10", 4)).toBe(true);
  });

  it("treats the boundary inclusively: exactly N business days apart is true, N+1 is false", () => {
    // 2026-03-04 (Wed) -> 2026-03-11 (Wed) is exactly 5 business days
    // (Thu,Fri,Mon,Tue,Wed). -> 2026-03-12 (Thu) is 6 business days.
    expect(withinBusinessDays("2026-03-04", "2026-03-11", 5)).toBe(true);
    expect(withinBusinessDays("2026-03-04", "2026-03-12", 5)).toBe(false);
  });
});

describe("reconcileDonations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
    nextSecurityId = 1000;
    nextTxnId = 1;
    nextDonationId = 1;
  });

  it("suggests an exact-date match: unlinked TRANSFER_OUT same security+qty+date as received_date", () => {
    const secId = seedSecurity(db, "ACME");
    const donationId = seedDonation(db, { securityId: secId, quantity: 100, receivedDate: "2026-04-15" });
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-15", type: "TRANSFER_OUT", quantity: 100 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(1);
    expect(report.suggestedMatches[0].donation.id).toBe(donationId);
    expect(report.suggestedMatches[0].outLeg.id).toBe(legId);
    expect(report.suggestedMatches[0].artifactLeg).toBeNull();
    expect(report.legsMissing).toHaveLength(0);
    expect(report.attempts).toHaveLength(0);
  });

  it("suggests a match +4 business days out, crossing a weekend", () => {
    const secId = seedSecurity(db, "WKND");
    const donationId = seedDonation(db, { securityId: secId, quantity: 50, receivedDate: "2026-03-04" });
    const legId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-03-10", type: "TRANSFER_OUT", quantity: 50 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(1);
    expect(report.suggestedMatches[0].donation.id).toBe(donationId);
    expect(report.suggestedMatches[0].outLeg.id).toBe(legId);
  });

  it("does not match +6 business days out — outside the ±5 window (leg lands in legsMissing/attempts instead)", () => {
    const secId = seedSecurity(db, "FAR6");
    const donationId = seedDonation(db, { securityId: secId, quantity: 50, receivedDate: "2026-03-04" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-03-12", type: "TRANSFER_OUT", quantity: 50 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(0);
    expect(report.legsMissing.map((d) => d.id)).toContain(donationId);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0].state).toBe("in-transit");
  });

  it("suggests a pair-donation match carrying BOTH legs for a zero-netting same-day IN+OUT pair", () => {
    const secId = seedSecurity(db, "PAIR");
    const donationId = seedDonation(db, { securityId: secId, quantity: 75, receivedDate: "2026-04-16" });
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-16", type: "TRANSFER_OUT", quantity: 75 });
    const artifactLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-04-16", type: "TRANSFER_IN", quantity: 75 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(1);
    const match = report.suggestedMatches[0];
    expect(match.donation.id).toBe(donationId);
    expect(match.outLeg.id).toBe(outLegId);
    expect(match.artifactLeg?.id).toBe(artifactLegId);
    expect(report.unmatchedPairs).toHaveLength(0);
  });

  it("does not suggest a match for a donation that already has a confirmed 'out' link", () => {
    const secId = seedSecurity(db, "LINKED");
    const donationId = seedDonation(db, { securityId: secId, quantity: 20, receivedDate: "2026-05-01" });
    const alreadyLinkedLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-01", type: "TRANSFER_OUT", quantity: 20 });
    linkLeg(db, donationId, alreadyLinkedLegId, "out");

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(0);
    expect(report.ambiguousMatches.map((a) => a.donation.id)).not.toContain(donationId);
    expect(report.legsMissing.map((d) => d.id)).not.toContain(donationId);
    // The already-linked leg is excluded from the candidate pool entirely — no attempt either.
    expect(report.attempts).toHaveLength(0);
  });

  it("excludes a reversed donation from every report section", () => {
    const secId = seedSecurity(db, "REVERSED");
    const donationId = seedDonation(db, {
      securityId: secId,
      quantity: 30,
      receivedDate: "2026-05-05",
      reversedDate: "2026-05-10",
    });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-05", type: "TRANSFER_OUT", quantity: 30 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches.map((m) => m.donation.id)).not.toContain(donationId);
    expect(report.ambiguousMatches.map((a) => a.donation.id)).not.toContain(donationId);
    expect(report.legsMissing.map((d) => d.id)).not.toContain(donationId);
  });

  it("flags a bounced sequence: unlinked OUT on day X, then a matching unlinked TRANSFER_IN on day X+40", () => {
    const secId = seedSecurity(db, "BOUNCE");
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-01", type: "TRANSFER_OUT", quantity: 12 });
    const returnLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-10", type: "TRANSFER_IN", quantity: 12 });

    const report = reconcileDonations(db);

    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0].leg.id).toBe(outLegId);
    expect(report.attempts[0].state).toBe("bounced");
    expect(report.attempts[0].returnLeg?.id).toBe(returnLegId);
  });

  it("flags a lone unmatched OUT with no donation and no return leg as in-transit", () => {
    const secId = seedSecurity(db, "LONE");
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-05-20", type: "TRANSFER_OUT", quantity: 8 });

    const report = reconcileDonations(db);

    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0].leg.id).toBe(outLegId);
    expect(report.attempts[0].state).toBe("in-transit");
    expect(report.attempts[0].returnLeg).toBeNull();
  });

  it("flags a duplicate-suspect group: two OUT legs sharing (account,date,security,qty,type) with differing amounts", () => {
    const secId = seedSecurity(db, "DUPE");
    const legA = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 0 });
    const legB = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-01", type: "TRANSFER_OUT", quantity: 5, amount: 4550 });

    const report = reconcileDonations(db);

    expect(report.duplicateSuspects).toHaveLength(1);
    const ids = report.duplicateSuspects[0].map((l) => l.id).sort();
    expect(ids).toEqual([legA, legB].sort());
  });

  it("reports a zero-netting pair with no matching donation as an unmatchedPair, not a suggestion", () => {
    const secId = seedSecurity(db, "REBOOK");
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-15", type: "TRANSFER_OUT", quantity: 9 });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-06-15", type: "TRANSFER_IN", quantity: 9 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(0);
    expect(report.unmatchedPairs).toHaveLength(1);
    expect(report.unmatchedPairs[0]).toMatchObject({ date: "2026-06-15", symbol: "REBOOK", quantity: 9 });
    expect(report.attempts).toHaveLength(0);
  });

  it("lands an ambiguous two-donation case in ambiguousMatches with both candidate legs — never suggested, never in-transit", () => {
    const secId = seedSecurity(db, "AMBIG");
    const donation1 = seedDonation(db, { securityId: secId, quantity: 40, receivedDate: "2026-07-01" });
    const donation2 = seedDonation(db, { securityId: secId, quantity: 40, receivedDate: "2026-07-02" });
    const legA = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-01", type: "TRANSFER_OUT", quantity: 40 });
    const legB = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-02", type: "TRANSFER_OUT", quantity: 40 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(0);
    expect(report.attempts).toHaveLength(0);
    expect(report.ambiguousMatches).toHaveLength(2);
    const byDonation = new Map(report.ambiguousMatches.map((a) => [a.donation.id, a.candidateLegs.map((l) => l.id).sort()]));
    expect(byDonation.get(donation1)).toEqual([legA, legB].sort());
    expect(byDonation.get(donation2)).toEqual([legA, legB].sort());
  });

  it("does not suggest a match for a non-USD-denominated security donation", () => {
    const secId = seedSecurity(db, "EURO", "EUR");
    const donationId = seedDonation(db, { securityId: secId, quantity: 60, receivedDate: "2026-07-10" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-10", type: "TRANSFER_OUT", quantity: 60 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches.map((m) => m.donation.id)).not.toContain(donationId);
    expect(report.ambiguousMatches.map((a) => a.donation.id)).not.toContain(donationId);
    expect(report.legsMissing.map((d) => d.id)).not.toContain(donationId);
  });

  it("excludes routing_artifact-linked legs from net-residual computation", () => {
    // A confirmed pair-donation from a PRIOR reconciliation run: the OUT leg is
    // 'out'-linked, the IN leg is 'routing_artifact'-linked. Neither should
    // resurface as a candidate for another donation or as an in-transit attempt.
    const secId = seedSecurity(db, "CONFIRMED");
    const donationId = seedDonation(db, { securityId: secId, quantity: 15, receivedDate: "2026-07-20" });
    const outLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-20", type: "TRANSFER_OUT", quantity: 15 });
    const artifactLegId = seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-20", type: "TRANSFER_IN", quantity: 15 });
    linkLeg(db, donationId, outLegId, "out");
    linkLeg(db, donationId, artifactLegId, "routing_artifact");

    const report = reconcileDonations(db);

    expect(report.suggestedMatches).toHaveLength(0);
    expect(report.attempts).toHaveLength(0);
    expect(report.unmatchedPairs).toHaveLength(0);
    expect(report.ambiguousMatches).toHaveLength(0);
  });

  it("does not suggest a match for a stock donation with a null quantity", () => {
    const secId = seedSecurity(db, "NOQTY");
    const donationId = seedDonation(db, { securityId: secId, quantity: null, receivedDate: "2026-07-25" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-07-25", type: "TRANSFER_OUT", quantity: 10 });

    const report = reconcileDonations(db);

    expect(report.suggestedMatches.map((m) => m.donation.id)).not.toContain(donationId);
    expect(report.legsMissing.map((d) => d.id)).toContain(donationId);
  });

  it("returns TransferLegRow shape with symbol and linked_role populated", () => {
    const secId = seedSecurity(db, "SHAPE");
    seedDonation(db, { securityId: secId, quantity: 5, receivedDate: "2026-08-01" });
    seedTxn(db, { accountId: ACCOUNT, securityId: secId, tradeDate: "2026-08-01", type: "TRANSFER_OUT", quantity: 5 });

    const report = reconcileDonations(db);
    const leg: TransferLegRow = report.suggestedMatches[0].outLeg;
    expect(leg.symbol).toBe("SHAPE");
    expect(leg.linked_role).toBeNull();
    expect(leg.type).toBe("TRANSFER_OUT");
  });
});
