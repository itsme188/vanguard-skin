/**
 * repair-security-type-corruption.ts — Config-driven repair for securities
 * whose security_type/name were corrupted by an import-time transcription
 * defect: a fragment of a bond's descriptive name landed in a row's SYMBOL
 * column, colliding with an already-held equity ticker. When the bad row
 * was later upserted, the incoming bond-like type/name/maturity stamped
 * bond identity onto the equity security, routing a live equity position
 * through the bond ÷100 valuation path. lib/mutations/securities.ts carries
 * an import-time guard (the equity-fill check added alongside this repair
 * script) that refuses this exact corruption on NEW upserts going forward —
 * this script is the one-time cleanup for rows that were corrupted BEFORE
 * that guard existed.
 *
 * The concrete affected security ids, symbols, transaction ids, and dollar
 * amounts are never hardcoded in this file — they live in a gitignored JSON
 * config (see loadRepairConfig) because this repository is public and those
 * values are real account data. Every id/symbol/amount appearing in this
 * file or its tests is synthetic.
 *
 * PREFLIGHT / APPLY SPLIT — all-or-nothing contract:
 *
 *   preflightTypeRepairs() is pure and read-only. For every configured
 *   repair it loads the current row and classifies it against the repair's
 *   expected "before" shape and intended "after" shape:
 *     - the row (or its symbol) doesn't match what the repair expects, or
 *       its current security_type/name matches NEITHER the expected nor the
 *       target state -> precondition_mismatch (the row moved since the
 *       repair entry was written — rerun, partial apply, unrelated edit —
 *       and applying blind would risk corrupting data a second time);
 *     - the row is already fully in the target state -> skipped_already_correct
 *       (safe no-op, makes the repair idempotent to rerun);
 *     - otherwise -> would_repair.
 *
 *   applyTypeRepairs() re-runs the exact same preflight check before writing
 *   anything. If ANY row comes back precondition_mismatch, it throws and
 *   writes NOTHING for the whole batch, not just the offending row — a
 *   partial apply would leave the repair config's assumptions (and any
 *   later stage layered on top, e.g. an interest-rehome pass keyed to the
 *   post-repair security ids) in an inconsistent, half-migrated state.
 *   Rows already at skipped_already_correct are silently left alone.
 *
 *   applyTypeRepairs runs its writes inline against the given db handle —
 *   it does not open its own transaction. A later CLI driver wraps type
 *   repairs together with other repair stages in ONE outer db.transaction
 *   so a night's repair run either fully lands or fully rolls back.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

// ─── Config shape ───────────────────────────────────────────────────

export interface KnownTypeRepair {
  id: number;
  symbol: string;
  expectType: string;
  setType: string;
  setName?: string;
  /** Required when setName is present — see loadRepairConfig validation. */
  expectNameLike?: string;
  clearBondFields?: boolean;
}

/** Consumed by a later task's rehome functions; defined here so
 *  loadRepairConfig can validate the shape of treasuryInterestRehomes. */
export interface InterestRehome {
  transactionId: number;
  fromSecurityId: number;
  toSecurityId: number;
  expectTradeDate: string;
  expectFees: number;
  setAmount: number;
  newSourceKey: string;
}

export interface CsvCorrection {
  file: string;
  approxLine: number;
  fix: string;
}

export interface RepairConfig {
  knownTypeRepairs: KnownTypeRepair[];
  treasuryInterestRehomes: InterestRehome[];
  neverUndoImportBatches: number[];
  csvCorrections: CsvCorrection[];
}

// ─── Config loading + validation ────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Optional-field helper: JSON has no `undefined`, so a hand-edited config
 *  may spell "absent" as `null`. Treat both the same way. */
function optionalString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : (v as string);
}

function requireArray(obj: Record<string, unknown>, key: string, configPath: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new Error(`repair config at ${configPath} is missing "${key}" (must be an array)`);
  }
  return value;
}

function validateKnownTypeRepair(raw: unknown, index: number): KnownTypeRepair {
  if (!isPlainObject(raw)) {
    throw new Error(`knownTypeRepairs[${index}] must be an object`);
  }
  if (!isFiniteNumber(raw.id)) {
    throw new Error(`knownTypeRepairs[${index}].id must be a number`);
  }
  if (typeof raw.symbol !== "string" || raw.symbol.length === 0) {
    throw new Error(`knownTypeRepairs[${index}].symbol must be a non-empty string`);
  }
  if (typeof raw.expectType !== "string" || raw.expectType.length === 0) {
    throw new Error(`knownTypeRepairs[${index}].expectType must be a non-empty string`);
  }
  if (typeof raw.setType !== "string" || raw.setType.length === 0) {
    throw new Error(`knownTypeRepairs[${index}].setType must be a non-empty string`);
  }
  const setName = optionalString(raw.setName);
  if (setName !== undefined && typeof setName !== "string") {
    throw new Error(`knownTypeRepairs[${index}].setName must be a string when present`);
  }
  const expectNameLike = optionalString(raw.expectNameLike);
  if (expectNameLike !== undefined && typeof expectNameLike !== "string") {
    throw new Error(`knownTypeRepairs[${index}].expectNameLike must be a string when present`);
  }
  if (setName !== undefined && expectNameLike === undefined) {
    throw new Error(
      `knownTypeRepairs[${index}]: expectNameLike is required when setName is present`,
    );
  }
  if (raw.clearBondFields !== undefined && typeof raw.clearBondFields !== "boolean") {
    throw new Error(`knownTypeRepairs[${index}].clearBondFields must be a boolean when present`);
  }
  return {
    id: raw.id,
    symbol: raw.symbol,
    expectType: raw.expectType,
    setType: raw.setType,
    setName,
    expectNameLike,
    clearBondFields: raw.clearBondFields as boolean | undefined,
  };
}

function validateInterestRehome(raw: unknown, index: number): InterestRehome {
  if (!isPlainObject(raw)) {
    throw new Error(`treasuryInterestRehomes[${index}] must be an object`);
  }
  if (!isFiniteNumber(raw.transactionId)) {
    throw new Error(`treasuryInterestRehomes[${index}].transactionId must be a number`);
  }
  if (!isFiniteNumber(raw.fromSecurityId)) {
    throw new Error(`treasuryInterestRehomes[${index}].fromSecurityId must be a number`);
  }
  if (!isFiniteNumber(raw.toSecurityId)) {
    throw new Error(`treasuryInterestRehomes[${index}].toSecurityId must be a number`);
  }
  if (typeof raw.expectTradeDate !== "string" || raw.expectTradeDate.length === 0) {
    throw new Error(`treasuryInterestRehomes[${index}].expectTradeDate must be a non-empty string`);
  }
  if (!isFiniteNumber(raw.expectFees)) {
    throw new Error(`treasuryInterestRehomes[${index}].expectFees must be a number`);
  }
  if (!isFiniteNumber(raw.setAmount)) {
    throw new Error(`treasuryInterestRehomes[${index}].setAmount must be a number`);
  }
  if (typeof raw.newSourceKey !== "string" || raw.newSourceKey.length === 0) {
    throw new Error(`treasuryInterestRehomes[${index}].newSourceKey must be a non-empty string`);
  }
  return {
    transactionId: raw.transactionId,
    fromSecurityId: raw.fromSecurityId,
    toSecurityId: raw.toSecurityId,
    expectTradeDate: raw.expectTradeDate,
    expectFees: raw.expectFees,
    setAmount: raw.setAmount,
    newSourceKey: raw.newSourceKey,
  };
}

function validateCsvCorrection(raw: unknown, index: number): CsvCorrection {
  if (!isPlainObject(raw)) {
    throw new Error(`csvCorrections[${index}] must be an object`);
  }
  if (typeof raw.file !== "string" || raw.file.length === 0) {
    throw new Error(`csvCorrections[${index}].file must be a non-empty string`);
  }
  if (!isFiniteNumber(raw.approxLine)) {
    throw new Error(`csvCorrections[${index}].approxLine must be a number`);
  }
  if (typeof raw.fix !== "string" || raw.fix.length === 0) {
    throw new Error(`csvCorrections[${index}].fix must be a non-empty string`);
  }
  return { file: raw.file, approxLine: raw.approxLine, fix: raw.fix };
}

/** Loads and validates the repair config from `configPath`. Throws on a
 *  missing file, invalid JSON, or any shape mismatch — this repairs real
 *  account data, so a malformed config must never partially apply. */
export function loadRepairConfig(configPath: string): RepairConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`repair config not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `repair config at ${configPath} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`repair config at ${configPath} must be a JSON object`);
  }

  const knownTypeRepairs = requireArray(parsed, "knownTypeRepairs", configPath).map(
    validateKnownTypeRepair,
  );
  const treasuryInterestRehomes = requireArray(
    parsed,
    "treasuryInterestRehomes",
    configPath,
  ).map(validateInterestRehome);
  const neverUndoImportBatches = requireArray(
    parsed,
    "neverUndoImportBatches",
    configPath,
  ).map((v, i) => {
    if (!isFiniteNumber(v)) {
      throw new Error(`neverUndoImportBatches[${i}] must be a number`);
    }
    return v;
  });
  const csvCorrections = requireArray(parsed, "csvCorrections", configPath).map(
    validateCsvCorrection,
  );

  return { knownTypeRepairs, treasuryInterestRehomes, neverUndoImportBatches, csvCorrections };
}

// ─── Preflight / apply core ─────────────────────────────────────────

export type TypeRepairAction =
  | "repaired"
  | "would_repair"
  | "skipped_already_correct"
  | "precondition_mismatch";

export interface TypeRepairOutcome {
  symbol: string;
  action: TypeRepairAction;
  previousType: string | null;
  detail?: string;
}

interface SecurityTypeRow {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
}

function loadSecurityTypeRow(
  db: Database.Database,
  id: number,
): SecurityTypeRow | undefined {
  return db
    .prepare(`SELECT id, symbol, name, security_type FROM securities WHERE id = ?`)
    .get(id) as SecurityTypeRow | undefined;
}

function mismatch(
  repair: KnownTypeRepair,
  previousType: string | null,
  detail: string,
): TypeRepairOutcome {
  return { symbol: repair.symbol, action: "precondition_mismatch", previousType, detail };
}

function classifyRepair(
  row: SecurityTypeRow | undefined,
  repair: KnownTypeRepair,
): TypeRepairOutcome {
  if (!row) {
    return mismatch(repair, null, `no security row with id ${repair.id}`);
  }
  if (row.symbol.toUpperCase() !== repair.symbol.toUpperCase()) {
    return mismatch(
      repair,
      row.security_type,
      `symbol mismatch: expected "${repair.symbol}", found "${row.symbol}"`,
    );
  }

  const currentType = (row.security_type ?? "").toLowerCase();
  const expectType = repair.expectType.toLowerCase();
  const setType = repair.setType.toLowerCase();

  if (currentType !== expectType && currentType !== setType) {
    return mismatch(
      repair,
      row.security_type,
      `security_type "${row.security_type ?? "(null)"}" matches neither expectType ` +
        `"${repair.expectType}" nor setType "${repair.setType}"`,
    );
  }

  const name = row.name ?? "";
  if (repair.expectNameLike !== undefined) {
    const nameMatchesExpected = name
      .toUpperCase()
      .includes(repair.expectNameLike.toUpperCase());
    const nameMatchesTarget = repair.setName !== undefined && name === repair.setName;
    if (!nameMatchesExpected && !nameMatchesTarget) {
      return mismatch(
        repair,
        row.security_type,
        `name "${row.name ?? "(null)"}" matches neither expectNameLike ` +
          `"${repair.expectNameLike}" nor the target name`,
      );
    }
  }

  const typeAlreadyCorrect = currentType === setType;
  const nameAlreadyCorrect = repair.setName === undefined || name === repair.setName;
  if (typeAlreadyCorrect && nameAlreadyCorrect) {
    return { symbol: repair.symbol, action: "skipped_already_correct", previousType: row.security_type };
  }

  return { symbol: repair.symbol, action: "would_repair", previousType: row.security_type };
}

/** Pure, read-only. Classifies every configured repair against the
 *  security table's current state — see the header doc for the outcome
 *  semantics. Never writes. */
export function preflightTypeRepairs(
  db: Database.Database,
  repairs: KnownTypeRepair[],
): TypeRepairOutcome[] {
  return repairs.map((repair) => classifyRepair(loadSecurityTypeRow(db, repair.id), repair));
}

const APPLY_UPDATE_SQL = `
  UPDATE securities
     SET security_type = @setType,
         name = COALESCE(@setName, name),
         maturity_date  = CASE WHEN @clearBondFields THEN NULL ELSE maturity_date END,
         duration_years = CASE WHEN @clearBondFields THEN NULL ELSE duration_years END,
         credit_rating  = CASE WHEN @clearBondFields THEN NULL ELSE credit_rating END,
         coupon_rate    = CASE WHEN @clearBondFields THEN NULL ELSE coupon_rate END
   WHERE id = @id
`;

/**
 * Re-runs preflightTypeRepairs and throws BEFORE writing anything if any
 * row comes back precondition_mismatch (all-or-nothing — see header doc).
 * Rows at skipped_already_correct are left alone. Runs inline against the
 * given db handle; the caller owns the transaction boundary.
 */
export function applyTypeRepairs(
  db: Database.Database,
  repairs: KnownTypeRepair[],
): TypeRepairOutcome[] {
  const outcomes = preflightTypeRepairs(db, repairs);

  const firstMismatch = outcomes.find((o) => o.action === "precondition_mismatch");
  if (firstMismatch) {
    throw new Error(
      `applyTypeRepairs: precondition_mismatch for ${firstMismatch.symbol} — ` +
        `${firstMismatch.detail ?? "current state does not match the repair config"}. ` +
        `Refusing to write anything for this batch.`,
    );
  }

  const update = db.prepare(APPLY_UPDATE_SQL);
  repairs.forEach((repair, i) => {
    const outcome = outcomes[i];
    if (outcome.action !== "would_repair") return;
    update.run({
      id: repair.id,
      setType: repair.setType,
      setName: repair.setName ?? null,
      clearBondFields: repair.clearBondFields ? 1 : 0,
    });
    outcome.action = "repaired";
  });

  return outcomes;
}

// ─── Interest re-home (bond coupon rows stranded on the wrong security) ──

export interface RehomeOutcome {
  transactionId: number;
  action: TypeRepairAction;
  detail?: string;
}

interface RehomeTransactionRow {
  id: number;
  security_id: number;
  trade_date: string;
  type: string;
  amount: number | null;
  fees: number | null;
  source_key: string | null;
}

const BOND_FAMILY_TYPES = new Set(["bond", "mutual fund", "mutual_fund"]);

function loadRehomeTransactionRow(
  db: Database.Database,
  id: number,
): RehomeTransactionRow | undefined {
  return db
    .prepare(
      `SELECT id, security_id, trade_date, type, amount, fees, source_key FROM transactions WHERE id = ?`,
    )
    .get(id) as RehomeTransactionRow | undefined;
}

function loadSecurityTypeById(db: Database.Database, id: number): string | null {
  const row = db.prepare(`SELECT security_type FROM securities WHERE id = ?`).get(id) as
    | { security_type: string | null }
    | undefined;
  return row?.security_type ?? null;
}

function rehomeMismatch(rehome: InterestRehome, detail: string): RehomeOutcome {
  return { transactionId: rehome.transactionId, action: "precondition_mismatch", detail };
}

function classifyRehome(db: Database.Database, rehome: InterestRehome): RehomeOutcome {
  const row = loadRehomeTransactionRow(db, rehome.transactionId);
  if (!row) {
    return rehomeMismatch(rehome, `no transaction row with id ${rehome.transactionId}`);
  }

  // Already fully at the target state -> idempotent no-op.
  if (row.security_id === rehome.toSecurityId && row.source_key === rehome.newSourceKey) {
    return { transactionId: rehome.transactionId, action: "skipped_already_correct" };
  }

  if (row.security_id !== rehome.fromSecurityId) {
    return rehomeMismatch(
      rehome,
      `security_id ${row.security_id} does not match expected fromSecurityId ${rehome.fromSecurityId}`,
    );
  }
  if (row.trade_date !== rehome.expectTradeDate) {
    return rehomeMismatch(
      rehome,
      `trade_date "${row.trade_date}" does not match expected "${rehome.expectTradeDate}"`,
    );
  }
  if ((row.type ?? "").toUpperCase() !== "INTEREST") {
    return rehomeMismatch(rehome, `type "${row.type}" is not INTEREST`);
  }
  if (row.amount !== null) {
    return rehomeMismatch(rehome, `amount is already populated (${row.amount}), row was hand-fixed`);
  }
  if (row.fees !== rehome.expectFees) {
    return rehomeMismatch(
      rehome,
      `fees ${row.fees} does not match expected ${rehome.expectFees}`,
    );
  }

  const targetType = (loadSecurityTypeById(db, rehome.toSecurityId) ?? "").toLowerCase();
  if (!BOND_FAMILY_TYPES.has(targetType)) {
    return rehomeMismatch(
      rehome,
      `target security ${rehome.toSecurityId} does not have a bond-family security_type`,
    );
  }

  const existingSourceKey = db
    .prepare(`SELECT id FROM transactions WHERE source_key = ?`)
    .get(rehome.newSourceKey) as { id: number } | undefined;
  if (existingSourceKey) {
    return rehomeMismatch(
      rehome,
      `source_key "${rehome.newSourceKey}" already exists on transaction id ${existingSourceKey.id} — a corrected re-import may have already landed`,
    );
  }

  return { transactionId: rehome.transactionId, action: "would_repair" };
}

/** Pure, read-only. Classifies every configured rehome against the
 *  transactions table's current state. Never writes. */
export function preflightRehomes(
  db: Database.Database,
  rehomes: InterestRehome[],
): RehomeOutcome[] {
  return rehomes.map((rehome) => classifyRehome(db, rehome));
}

const REHOME_UPDATE_SQL = `
  UPDATE transactions
     SET security_id = @toSecurityId, amount = @setAmount, fees = 0, source_key = @newSourceKey
   WHERE id = @transactionId
`;

/**
 * Re-runs preflightRehomes and throws BEFORE writing anything if any row
 * comes back precondition_mismatch — same all-or-nothing contract as
 * applyTypeRepairs. Runs inline against the given db handle; the caller
 * owns the transaction boundary (a later CLI driver wraps type repairs and
 * rehomes together in one outer db.transaction).
 */
export function applyRehomes(
  db: Database.Database,
  rehomes: InterestRehome[],
): RehomeOutcome[] {
  const outcomes = preflightRehomes(db, rehomes);

  const firstMismatch = outcomes.find((o) => o.action === "precondition_mismatch");
  if (firstMismatch) {
    throw new Error(
      `applyRehomes: precondition_mismatch for transaction ${firstMismatch.transactionId} — ` +
        `${firstMismatch.detail ?? "current state does not match the rehome config"}. ` +
        `Refusing to write anything for this batch.`,
    );
  }

  const update = db.prepare(REHOME_UPDATE_SQL);
  rehomes.forEach((rehome, i) => {
    const outcome = outcomes[i];
    if (outcome.action !== "would_repair") return;
    update.run({
      transactionId: rehome.transactionId,
      toSecurityId: rehome.toSecurityId,
      setAmount: rehome.setAmount,
      newSourceKey: rehome.newSourceKey,
    });
    outcome.action = "repaired";
  });

  return outcomes;
}

// ─── Contradiction detector (review-only, never auto-repaired) ──────

export interface ContradictionRow {
  id: number;
  symbol: string;
  securityType: string;
  equityFills: number;
  fundCategory: string | null;
  reason: string;
}

interface RawContradictionRow {
  id: number;
  symbol: string;
  security_type: string | null;
  equity_fills: number;
  fund_category: string | null;
}

const PREDICATE_1_SQL = `
  -- Predicate 1: bond/fund-typed securities whose ledger is dominated by equity fills
  -- (floor >10: genuine mutual funds legitimately show some fills; the audit's corrupted
  -- row sat far above every real fund).
  SELECT s.id, s.symbol, s.security_type,
         SUM(CASE WHEN UPPER(t.type) IN ('BUY','SELL','SHORT_SELL','BUY_TO_COVER')
                   AND t.quantity IS NOT NULL AND t.quantity <> 0 THEN 1 ELSE 0 END) AS equity_fills,
         s.fund_category
    FROM securities s JOIN transactions t ON t.security_id = s.id
   WHERE LOWER(COALESCE(s.security_type,'')) IN ('bond','mutual fund','mutual_fund')
   GROUP BY s.id
  HAVING equity_fills > 10
`;

const PREDICATE_2_SQL = `
  -- Predicate 2: equity-shaped classification metadata contradicting a bond/fund type.
  -- Bond/mutual-fund types ONLY — never 'etf' (sector ETFs legitimately carry
  -- "US Sector Equity%" fund categories; an ETF-typed contradiction needs
  -- contract-details stockType evidence, which is TWS territory, not this detector).
  SELECT id, symbol, security_type, 0 AS equity_fills, fund_category
    FROM securities
   WHERE fund_category LIKE 'US Sector Equity%'
     AND LOWER(COALESCE(security_type,'')) IN ('bond','mutual fund','mutual_fund')
`;

/**
 * Read-only detector for securities whose stored security_type contradicts
 * other evidence (ledger activity shaped like equity trading, or an equity
 * fund_category on a bond/fund-typed row). These are NEEDS REVIEW hits —
 * this function never repairs anything; a human confirms and adds a
 * KnownTypeRepair entry to the config before any write happens.
 */
export function findTypeContradictions(
  db: Database.Database,
  excludeIds: number[],
): ContradictionRow[] {
  const excludeSet = new Set(excludeIds);
  const byId = new Map<number, ContradictionRow>();

  const predicate1 = db.prepare(PREDICATE_1_SQL).all() as RawContradictionRow[];
  for (const row of predicate1) {
    if (excludeSet.has(row.id)) continue;
    byId.set(row.id, {
      id: row.id,
      symbol: row.symbol,
      securityType: row.security_type ?? "",
      equityFills: row.equity_fills,
      fundCategory: row.fund_category,
      reason: "dominated by equity fills",
    });
  }

  const predicate2 = db.prepare(PREDICATE_2_SQL).all() as RawContradictionRow[];
  for (const row of predicate2) {
    if (excludeSet.has(row.id)) continue;
    const existing = byId.get(row.id);
    if (existing) {
      existing.reason = "dominated by equity fills; equity-shaped fund_category";
    } else {
      byId.set(row.id, {
        id: row.id,
        symbol: row.symbol,
        securityType: row.security_type ?? "",
        equityFills: row.equity_fills,
        fundCategory: row.fund_category,
        reason: "equity-shaped fund_category",
      });
    }
  }

  return Array.from(byId.values());
}

// ─── CLI driver ─────────────────────────────────────────────────────
//
// Dry-run (default) opens the live DB READONLY and writes nothing —
// safe to run at any time. --apply opens read-write, and only writes
// after BOTH preflight lanes (type repairs + rehomes) come back clean
// (no precondition_mismatch anywhere) — see the header doc's
// all-or-nothing contract. The two apply functions are wrapped in ONE
// outer db.transaction here so a night's repair either fully lands or
// fully rolls back; neither applyTypeRepairs nor applyRehomes opens its
// own transaction (see their doc comments).
//
// Config path and every id/symbol/amount printed below come from the
// gitignored local config (see loadRepairConfig's header doc) — nothing
// live is hardcoded in this file.

const DB_PATH = path.join(process.cwd(), "data", "vanguard.db");
const CONFIG_PATH = path.join(process.cwd(), "data", "repair-configs", "security-type-corruption.json");

interface SecurityEvidenceRow {
  id: number;
  symbol: string;
  security_type: string | null;
  name: string | null;
  maturity_date: string | null;
}

function printSecurityEvidenceRow(db: Database.Database, id: number): void {
  const row = db
    .prepare(`SELECT id, symbol, security_type, name, maturity_date FROM securities WHERE id = ?`)
    .get(id) as SecurityEvidenceRow | undefined;
  if (!row) {
    console.log(`  id=${id}: NOT FOUND`);
    return;
  }
  console.log(
    `  id=${row.id} symbol=${row.symbol} security_type=${row.security_type ?? "(null)"} ` +
      `name="${row.name ?? ""}" maturity_date=${row.maturity_date ?? "(null)"}`,
  );
}

interface TransactionEvidenceRow {
  id: number;
  trade_date: string;
  type: string;
  quantity: number | null;
  amount: number | null;
  fees: number | null;
  security_id: number;
  source_key: string | null;
}

function printTransactionEvidenceRow(db: Database.Database, id: number): void {
  const row = db
    .prepare(
      `SELECT id, trade_date, type, quantity, amount, fees, security_id, source_key
         FROM transactions WHERE id = ?`,
    )
    .get(id) as TransactionEvidenceRow | undefined;
  if (!row) {
    console.log(`  id=${id}: NOT FOUND`);
    return;
  }
  console.log(
    `  id=${row.id} trade_date=${row.trade_date} type=${row.type} ` +
      `quantity=${row.quantity ?? "(null)"} amount=${row.amount ?? "(null)"} fees=${row.fees ?? "(null)"} ` +
      `security_id=${row.security_id} source_key=${row.source_key ?? "(null)"}`,
  );
}

function printOutcomeLine(label: string, action: TypeRepairAction, detail?: string): void {
  console.log(`  ${label}: ${action}${detail ? ` — ${detail}` : ""}`);
}

function printCsvCorrections(config: RepairConfig): void {
  console.log(
    "\nCSV corrections (MANDATORY — rewriting a coupon row's source_key frees its " +
      "original key; re-importing the UNCORRECTED source file would re-insert the bad " +
      "row under that freed key. The corrected file dedupes against the rewritten key.):",
  );
  if (config.csvCorrections.length === 0) {
    console.log("  none configured");
    return;
  }
  for (const c of config.csvCorrections) {
    console.log(`  ${c.file}:${c.approxLine} — ${c.fix}`);
  }
}

function printNeverUndoWarning(config: RepairConfig): void {
  if (config.neverUndoImportBatches.length === 0) return;
  console.log(
    `\nNEVER undo import batch(es) [${config.neverUndoImportBatches.join(", ")}] — ` +
      `undoing these batches would DELETE the repaired coupon rows.`,
  );
}

/** Prints cash_balance + holdings_value = total_value for every account at
 *  the latest computed valuation_date, so a human can eyeball the identity
 *  held right after a full daily_valuations rebuild. computeDailyValuations
 *  derives total_value as cash_balance + holdings_value by construction, so
 *  a nonzero delta here means something wrote to daily_valuations outside
 *  that function — flagged, not silently trusted. */
function printDailyIdentityCheck(db: Database.Database): void {
  const latest = db.prepare(`SELECT MAX(valuation_date) AS d FROM daily_valuations`).get() as {
    d: string | null;
  };
  console.log("\nDaily-identity check (cash_balance + holdings_value = total_value):");
  if (!latest.d) {
    console.log("  no daily_valuations rows found");
    return;
  }
  const rows = db
    .prepare(
      `SELECT dv.account_id, a.name AS account_name, dv.cash_balance, dv.holdings_value, dv.total_value
         FROM daily_valuations dv JOIN accounts a ON a.id = dv.account_id
        WHERE dv.valuation_date = ?
        ORDER BY dv.account_id`,
    )
    .all(latest.d) as Array<{
    account_id: number;
    account_name: string;
    cash_balance: number;
    holdings_value: number;
    total_value: number;
  }>;
  console.log(`  as of ${latest.d}:`);
  for (const r of rows) {
    const sum = r.cash_balance + r.holdings_value;
    const delta = Math.abs(sum - r.total_value);
    const ok = delta < 0.01 ? "OK" : `MISMATCH (delta=${delta.toFixed(2)})`;
    console.log(
      `    ${r.account_name} (id=${r.account_id}): cash=${r.cash_balance.toFixed(2)} + ` +
        `holdings=${r.holdings_value.toFixed(2)} = ${sum.toFixed(2)} vs stored total=${r.total_value.toFixed(2)} — ${ok}`,
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const { default: BetterSqlite3 } = await import("better-sqlite3");
  const db = new BetterSqlite3(DB_PATH, { readonly: !apply }) as Database.Database;
  if (apply) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }

  try {
    console.log(
      `Security-type corruption repair ${apply ? "[APPLY]" : "[DRY RUN]"} — db: ${DB_PATH}\n`,
    );

    let config: RepairConfig;
    try {
      config = loadRepairConfig(CONFIG_PATH);
    } catch (err) {
      console.error(
        `ERROR loading repair config: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(`Expected config at: ${CONFIG_PATH}`);
      console.error(
        "See the RepairConfig interface in scripts/repair-security-type-corruption.ts for the required shape.",
      );
      process.exitCode = 1;
      return;
    }

    console.log("Evidence — current row state:\n");
    console.log("Securities (knownTypeRepairs):");
    for (const repair of config.knownTypeRepairs) {
      printSecurityEvidenceRow(db, repair.id);
    }
    console.log("\nTransactions (treasuryInterestRehomes):");
    for (const rehome of config.treasuryInterestRehomes) {
      printTransactionEvidenceRow(db, rehome.transactionId);
    }

    const typeOutcomes = preflightTypeRepairs(db, config.knownTypeRepairs);
    console.log("\nType-repair preflight:");
    for (const o of typeOutcomes) {
      printOutcomeLine(o.symbol, o.action, o.detail);
    }

    const rehomeOutcomes = preflightRehomes(db, config.treasuryInterestRehomes);
    console.log("\nRehome preflight:");
    for (const o of rehomeOutcomes) {
      printOutcomeLine(`transaction ${o.transactionId}`, o.action, o.detail);
    }

    const configuredIds = config.knownTypeRepairs.map((r) => r.id);
    const contradictions = findTypeContradictions(db, configuredIds);
    console.log("\nContradiction detector (never auto-repaired):");
    if (contradictions.length === 0) {
      console.log("  none found");
    } else {
      console.log(
        "  NEEDS REVIEW — not auto-repaired; verify against source documents, then add to the config:",
      );
      for (const c of contradictions) {
        console.log(
          `    id=${c.id} symbol=${c.symbol} security_type=${c.securityType} ` +
            `equityFills=${c.equityFills} fundCategory=${c.fundCategory ?? "(null)"} reason=${c.reason}`,
        );
      }
    }

    if (!apply) {
      printCsvCorrections(config);
      printNeverUndoWarning(config);
      console.log("\nDry-run (default). Re-run with --apply to write.");
      return;
    }

    const anyMismatch = [...typeOutcomes, ...rehomeOutcomes].some(
      (o) => o.action === "precondition_mismatch",
    );
    if (anyMismatch) {
      console.error(
        "\nABORTING — one or more rows are precondition_mismatch (see preflight output above). " +
          "No writes made.",
      );
      process.exitCode = 1;
      return;
    }

    const { ensureBackup } = await import("@/scripts/rebuild-ibkr-ledger");
    const backupPath = path.join(
      process.cwd(),
      "data",
      "backups",
      `pre-security-type-repair-${new Date().toISOString().replace(/:/g, "-")}.db`,
    );
    const backup = ensureBackup(db, backupPath);
    console.log(
      `\nBackup ${backup.created ? "created" : "already present"} at ${backup.path} (${backup.sizeBytes} bytes)`,
    );

    db.transaction(() => {
      applyTypeRepairs(db, config.knownTypeRepairs);
      applyRehomes(db, config.treasuryInterestRehomes);
    })();
    console.log("\nApplied — type repairs + rehomes committed in one transaction.");

    const { computeTaxLots } = await import("@/lib/compute/tax-lots");
    const { computeDailyValuations } = await import("@/lib/compute/daily-valuation");

    console.log("\nRecomputing tax lots...");
    const taxResult = computeTaxLots(db);
    console.log(
      `  lots=${taxResult.lotsCreated} sales=${taxResult.salesProcessed} ` +
        `totalRealizedGain=$${taxResult.totalRealizedGain.toFixed(2)}`,
    );

    console.log("\nRecomputing daily valuations...");
    const valResult = computeDailyValuations(db);
    console.log(
      `  datesComputed=${valResult.datesComputed} accountsProcessed=${valResult.accountsProcessed}`,
    );

    printDailyIdentityCheck(db);

    printCsvCorrections(config);
    printNeverUndoWarning(config);
    console.log(
      "\nRe-enrich the repaired equity on the next TWS connect (exchange/sector refresh — " +
        "the retype makes the STK contract path valid again).",
    );
  } finally {
    db.close();
  }
}

// Detect if this file is being run directly (not imported by tests) —
// mirrors scripts/repair-etf-types.ts:438-449.
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] != null &&
  (process.argv[1].endsWith("repair-security-type-corruption.ts") ||
    process.argv[1].endsWith("repair-security-type-corruption.js"));

if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
