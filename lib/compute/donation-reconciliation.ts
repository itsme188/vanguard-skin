import type Database from "better-sqlite3";
import { getDonations, type DonationRow } from "@/lib/queries/donations";

/**
 * Reconciliation module (spec §7, donation-tracking design) — matches
 * unlinked TRANSFER_IN/TRANSFER_OUT legs against `donations` rows.
 *
 * This is a SUGGESTION engine only: nothing here writes to the database or
 * consumes tax lots. A suggestion becomes real only via a persisted
 * `donation_leg_links` row, created by user confirmation (Task 12/13) or a
 * reviewed repair `--apply` (Task 11).
 */

const EPS = 1e-9;
const MATCH_WINDOW_BUSINESS_DAYS = 5;

export interface TransferLegRow {
  id: number;
  account_id: number;
  security_id: number;
  trade_date: string;
  type: "TRANSFER_IN" | "TRANSFER_OUT";
  quantity: number;
  amount: number | null;
  is_external_flow: number;
  symbol: string;
  linked_role: "out" | "routing_artifact" | null;
}

export interface ReconciliationReport {
  suggestedMatches: { donation: DonationRow; outLeg: TransferLegRow; artifactLeg: TransferLegRow | null }[];
  /** 2+ candidates either direction — never auto-suggested (Codex plan-review #7). */
  ambiguousMatches: { donation: DonationRow; candidateLegs: TransferLegRow[] }[];
  attempts: { leg: TransferLegRow; state: "in-transit" | "bounced"; returnLeg: TransferLegRow | null }[];
  /** Eligible stock donations with NO candidate legs at all (report-only class). */
  legsMissing: DonationRow[];
  /** Groups sharing (account,date,security,qty,type), differing amounts. */
  duplicateSuspects: TransferLegRow[][];
  /** Zero-netting pairs matching no donation — informational. */
  unmatchedPairs: { date: string; symbol: string; quantity: number }[];
}

/**
 * ±N business days (weekends only; holidays ignored — documented
 * approximation). Direction-agnostic: works whichever date is earlier.
 * Exported for tests.
 */
export function withinBusinessDays(a: string, b: string, n: number): boolean {
  return Math.abs(businessDayDiff(a, b)) <= n;
}

function businessDayDiff(a: string, b: string): number {
  const start = new Date(`${a}T00:00:00Z`).getTime();
  const end = new Date(`${b}T00:00:00Z`).getTime();
  if (start === end) return 0;
  const DAY_MS = 86_400_000;
  const sign = end > start ? 1 : -1;
  let cur = start;
  let count = 0;
  while (cur !== end) {
    cur += sign * DAY_MS;
    const dow = new Date(cur).getUTCDay();
    if (dow !== 0 && dow !== 6) count += sign;
  }
  return count;
}

/** legs + donation_leg_links + securities.symbol join — every TRANSFER_IN/OUT
 *  leg that carries a security (excludes cash TRANSFER legs, per IN_KIND_LEG_SQL
 *  precedent in lib/compute/flow-adjusted.ts). */
function fetchLegs(db: Database.Database): TransferLegRow[] {
  return db
    .prepare(
      `SELECT t.id, t.account_id, t.security_id, t.trade_date, t.type, t.quantity, t.amount,
              t.is_external_flow, s.symbol AS symbol, l.role AS linked_role
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       LEFT JOIN donation_leg_links l ON l.transaction_id = t.id
       WHERE t.type IN ('TRANSFER_IN','TRANSFER_OUT')
         AND t.security_id IS NOT NULL
         AND t.quantity IS NOT NULL
       ORDER BY t.trade_date, t.id`
    )
    .all() as TransferLegRow[];
}

function fetchUsdSecurityIds(db: Database.Database): Set<number> {
  const rows = db.prepare(`SELECT id FROM securities WHERE COALESCE(currency, 'USD') = 'USD'`).all() as {
    id: number;
  }[];
  return new Set(rows.map((r) => r.id));
}

/** Existing links — used to determine which donations already have a
 *  confirmed 'out' link (excluded from every suggestion/ambiguity/missing
 *  class; they're already resolved). */
function fetchOutLinkedDonationIds(db: Database.Database): Set<number> {
  const rows = db.prepare(`SELECT donation_id FROM donation_leg_links WHERE role = 'out'`).all() as {
    donation_id: number;
  }[];
  return new Set(rows.map((r) => r.donation_id));
}

function isEligibleForSuggestion(
  d: DonationRow,
  usdSecurityIds: Set<number>,
  outLinkedDonationIds: Set<number>
): boolean {
  return (
    d.kind === "stock" &&
    d.reversed_date == null &&
    d.security_id != null &&
    usdSecurityIds.has(d.security_id) &&
    !outLinkedDonationIds.has(d.id)
  );
}

/** A (account, trade_date, security) bucket of UNLINKED legs — net residual
 *  per spec §7: TRANSFER_OUT minus TRANSFER_IN, excluding routing_artifact
 *  (and, since we only bucket unlinked legs, 'out') links entirely. */
interface Bucket {
  accountId: number;
  securityId: number;
  tradeDate: string;
  outLegs: TransferLegRow[];
  inLegs: TransferLegRow[];
  outQty: number;
  inQty: number;
  residual: number;
}

function buildBuckets(legs: TransferLegRow[]): Bucket[] {
  const unlinked = legs.filter((l) => l.linked_role == null);
  const byKey = new Map<string, Bucket>();
  for (const leg of unlinked) {
    const key = `${leg.account_id}|${leg.trade_date}|${leg.security_id}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = {
        accountId: leg.account_id,
        securityId: leg.security_id,
        tradeDate: leg.trade_date,
        outLegs: [],
        inLegs: [],
        outQty: 0,
        inQty: 0,
        residual: 0,
      };
      byKey.set(key, bucket);
    }
    if (leg.type === "TRANSFER_OUT") {
      bucket.outLegs.push(leg);
      bucket.outQty += leg.quantity;
    } else {
      bucket.inLegs.push(leg);
      bucket.inQty += leg.quantity;
    }
  }
  for (const bucket of byKey.values()) bucket.residual = bucket.outQty - bucket.inQty;
  return [...byKey.values()];
}

/** A single candidate against which donations are matched: either a positive
 *  net residual (an outbound leg not yet explained) or a same-day
 *  zero-netting IN+OUT pair (pair-donation form). */
interface Candidate {
  kind: "residual" | "pair";
  bucket: Bucket;
  quantity: number;
  outLeg: TransferLegRow;
  artifactLeg: TransferLegRow | null;
}

function buildCandidates(buckets: Bucket[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const bucket of buckets) {
    if (bucket.residual > EPS) {
      candidates.push({ kind: "residual", bucket, quantity: bucket.residual, outLeg: bucket.outLegs[0], artifactLeg: null });
    } else if (Math.abs(bucket.residual) <= EPS && bucket.outQty > EPS && bucket.inQty > EPS) {
      candidates.push({ kind: "pair", bucket, quantity: bucket.outQty, outLeg: bucket.outLegs[0], artifactLeg: bucket.inLegs[0] });
    }
  }
  return candidates;
}

function matchesDonation(c: Candidate, d: DonationRow): boolean {
  return (
    c.bucket.securityId === d.security_id &&
    d.quantity != null &&
    Math.abs(c.quantity - d.quantity) <= EPS &&
    withinBusinessDays(d.received_date, c.bucket.tradeDate, MATCH_WINDOW_BUSINESS_DAYS)
  );
}

/** Unlinked TRANSFER_IN, same security+account+quantity, strictly later date
 *  than the outbound leg — "a matching later TRANSFER_IN of same security+
 *  quantity" (spec §7 attempt states), itself unlinked. Ties broken by the
 *  earliest date, then lowest id, for determinism. */
function findReturnLeg(legs: TransferLegRow[], outLeg: TransferLegRow): TransferLegRow | null {
  const returns = legs.filter(
    (l) =>
      l.type === "TRANSFER_IN" &&
      l.linked_role == null &&
      l.security_id === outLeg.security_id &&
      l.account_id === outLeg.account_id &&
      Math.abs(l.quantity - outLeg.quantity) <= EPS &&
      l.trade_date > outLeg.trade_date
  );
  if (returns.length === 0) return null;
  returns.sort((a, b) => (a.trade_date === b.trade_date ? a.id - b.id : a.trade_date < b.trade_date ? -1 : 1));
  return returns[0];
}

/** Groups sharing (account,date,security,qty,type) whose amounts differ —
 *  a re-import / re-authoring artifact, not a real second transfer. Scans
 *  ALL legs (linked or not) since a duplicate is a data-quality signal
 *  independent of matching state. */
function findDuplicateSuspects(legs: TransferLegRow[]): TransferLegRow[][] {
  const byKey = new Map<string, TransferLegRow[]>();
  for (const leg of legs) {
    const key = `${leg.account_id}|${leg.trade_date}|${leg.security_id}|${leg.quantity}|${leg.type}`;
    const group = byKey.get(key);
    if (group) group.push(leg);
    else byKey.set(key, [leg]);
  }
  const suspects: TransferLegRow[][] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const distinctAmounts = new Set(group.map((l) => (l.amount == null ? "null" : l.amount.toFixed(6))));
    if (distinctAmounts.size > 1) suspects.push(group);
  }
  return suspects;
}

export function reconcileDonations(db: Database.Database): ReconciliationReport {
  const legs = fetchLegs(db);
  const donations = getDonations(db);
  const usdSecurityIds = fetchUsdSecurityIds(db);
  const outLinkedDonationIds = fetchOutLinkedDonationIds(db);

  const eligibleDonations = donations.filter((d) => isEligibleForSuggestion(d, usdSecurityIds, outLinkedDonationIds));

  const buckets = buildBuckets(legs);
  const candidates = buildCandidates(buckets);

  const suggestedMatches: ReconciliationReport["suggestedMatches"] = [];
  const ambiguousMatches: ReconciliationReport["ambiguousMatches"] = [];
  const legsMissing: DonationRow[] = [];
  const claimed = new Set<Candidate>();

  for (const donation of eligibleDonations) {
    const matches = candidates.filter((c) => matchesDonation(c, donation));
    if (matches.length === 0) {
      legsMissing.push(donation);
      continue;
    }
    const isClean =
      matches.length === 1 &&
      eligibleDonations.filter((d) => matchesDonation(matches[0], d)).length === 1;
    if (isClean) {
      suggestedMatches.push({ donation, outLeg: matches[0].outLeg, artifactLeg: matches[0].artifactLeg });
      claimed.add(matches[0]);
    } else {
      ambiguousMatches.push({ donation, candidateLegs: matches.map((m) => m.outLeg) });
      for (const m of matches) claimed.add(m);
    }
  }

  const attempts: ReconciliationReport["attempts"] = [];
  const unmatchedPairs: ReconciliationReport["unmatchedPairs"] = [];
  for (const candidate of candidates) {
    if (claimed.has(candidate)) continue;
    if (candidate.kind === "residual") {
      const returnLeg = findReturnLeg(legs, candidate.outLeg);
      attempts.push({ leg: candidate.outLeg, state: returnLeg ? "bounced" : "in-transit", returnLeg });
    } else {
      unmatchedPairs.push({ date: candidate.bucket.tradeDate, symbol: candidate.outLeg.symbol, quantity: candidate.quantity });
    }
  }

  const duplicateSuspects = findDuplicateSuspects(legs);

  return { suggestedMatches, ambiguousMatches, attempts, legsMissing, duplicateSuspects, unmatchedPairs };
}
