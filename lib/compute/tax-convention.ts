import type Database from "better-sqlite3";

/**
 * Generation-bound convention markers for the tax-lots dollar convention
 * (spec: number-trust durable fixes, WS1). The generation counter advances
 * on every MATERIAL tax-input mutation; both markers bind to it so a stale
 * stamp can never survive new data. All readers go through
 * getTaxConventionState — never parse the settings rows elsewhere.
 */

export interface AcceptanceCoverage { accountId: number; taxYear: number }
export interface TaxConventionState {
  generation: number;
  recomputeCurrent: boolean;
  acceptance: { current: boolean; coverage: AcceptanceCoverage[] };
}

const GEN_KEY = "tax_input_generation";
const CONVENTION_KEY = "tax_lots_convention";
const ACCEPTANCE_KEY = "tax_report_broker_accepted";

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getTaxInputGeneration(db: Database.Database): number {
  const raw = readSetting(db, GEN_KEY);
  const n = raw == null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Call inside the mutating transaction. Returns the new generation. */
export function bumpTaxInputGeneration(db: Database.Database): number {
  const next = getTaxInputGeneration(db) + 1;
  writeSetting(db, GEN_KEY, String(next));
  return next;
}

export function stampTaxLotsConvention(db: Database.Database): void {
  writeSetting(db, CONVENTION_KEY, `v2:${getTaxInputGeneration(db)}`);
}

export function stampBrokerAcceptance(
  db: Database.Database,
  coverage: AcceptanceCoverage[]
): void {
  writeSetting(
    db,
    ACCEPTANCE_KEY,
    JSON.stringify({ generation: getTaxInputGeneration(db), coverage })
  );
}

export function getTaxConventionState(db: Database.Database): TaxConventionState {
  const generation = getTaxInputGeneration(db);
  const conv = readSetting(db, CONVENTION_KEY);
  const m = conv == null ? null : /^v2:(\d+)$/.exec(conv);
  const recomputeCurrent = m != null && Number.parseInt(m[1], 10) === generation;

  let acceptance: TaxConventionState["acceptance"] = { current: false, coverage: [] };
  const rawAcc = readSetting(db, ACCEPTANCE_KEY);
  if (rawAcc != null) {
    try {
      const parsed = JSON.parse(rawAcc) as { generation?: number; coverage?: AcceptanceCoverage[] };
      const coverage = Array.isArray(parsed.coverage) ? parsed.coverage : [];
      acceptance = { current: parsed.generation === generation && recomputeCurrent, coverage };
    } catch {
      // unparseable stamp = no acceptance (fail closed)
    }
  }
  return { generation, recomputeCurrent, acceptance };
}

export function isYearAccepted(
  state: TaxConventionState,
  taxYear: number,
  accountIds: number[]
): boolean {
  if (!state.acceptance.current) return false;
  return accountIds.every((accountId) =>
    state.acceptance.coverage.some((c) => c.accountId === accountId && c.taxYear === taxYear)
  );
}

/**
 * The one settings-table probe. Mutation sites run against minimal test DBs
 * that never created `settings`; every guarded wrapper below shares this
 * check rather than inlining its own sqlite_master query.
 */
function hasSettingsTable(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get() != null
  );
}

/**
 * Wrapper for mutation sites that run on minimal test DBs (no settings table).
 * No-ops if the settings table is missing.
 */
export function bumpTaxGenerationIfPresent(db: Database.Database): number {
  if (!hasSettingsTable(db)) {
    return 0; // settings table doesn't exist; return 0 (no-op)
  }

  return bumpTaxInputGeneration(db);
}

/**
 * Same guard for the recompute marker: `computeTaxLots` stamps as its final
 * in-transaction act, and it too runs against minimal test DBs.
 */
export function stampTaxLotsConventionIfPresent(db: Database.Database): void {
  if (!hasSettingsTable(db)) return;
  stampTaxLotsConvention(db);
}
