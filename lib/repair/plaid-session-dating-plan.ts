/**
 * Plaid session-dating history repair: the planner (plan v4, section D).
 *
 * Old ("legacy") Plaid rows are dated on the RUN day d of the pre-open read,
 * but a pre-open read describes the close of t = previousTradingDay(d). This
 * module decides, for every legacy Plaid row, what the repair does with it,
 * and writes the decision as a manifest. `scripts/repair-plaid-session-dating.ts`
 * is the command line; the read-only audit (scripts/audit-plaid-session-dating.ts)
 * imports the types from here.
 *
 * Design rules (spec D):
 *  - The repair handles exactly a MEASURED set of hard cases and BLOCKS on
 *    anything else (D0). The measured set is portfolio-specific, so it is not
 *    in code: it comes from a gitignored JSON config, validated here
 *    (`validateMeasuredSetConfig`) and bound into the manifest by its SHA-256.
 *  - Every book (account, run day) is decided whole, oldest first (D3).
 *  - Tombstone rules (D4) are checked on the complete PLANNED timeline: every
 *    row first gets its final date (or deletion), then the conditions are
 *    validated against those final dates.
 *  - Plaid prices follow D5: P1 fund shift, P2 non-fund delete, P3 rows the
 *    earlier stock/ETF price build already dated on the session.
 *  - Nothing here writes to the database it plans from. The apply step
 *    (`applyManifestChanges`) runs inside the caller's transaction.
 *
 * "Full holdings book" evidence (D3 survivor rule). The database stores no
 * marker that an import batch carried a complete holdings snapshot. The
 * strongest stored evidence is used instead, and a survivor is zeroed only
 * when ALL of it holds:
 *  1. every statement-prefix holdings row of the account on d carries an
 *     import batch id, and each such batch is `completed`;
 *  2. each batch's source type is one the import engine treats as a full
 *     holdings snapshot (`HOLDINGS_SNAPSHOT_SOURCE_TYPES` below, a mirror of
 *     the engine's own `HOLDINGS_SNAPSHOT_SOURCES` plus canonical-csv, which
 *     the engine accepts when the parse carried holdings);
 *  3. each batch's stored parse (`raw_imports.raw_data`, the engine's
 *     `JSON.stringify(parsed)`) has holdings rows for this account name on d,
 *     and none of them names the survivor's symbol.
 * Anything missing or unreadable is BLOCK, never a guess.
 */

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { isMarketClosed, nextTradingDay, previousTradingDay } from "@/lib/calendar/market-holidays";
import { nowET, todayET } from "@/lib/calendar/date-utils";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { TAX_TREATMENT_LABELS, isTaxableAccount, isTaxTreatment } from "@/lib/compute/tax-treatment";
import {
  RECON_HOLDING_SOURCE_PREFIX,
  RECON_LIVE_SUFFIX,
  statementGradeHoldingSql,
  statementSourcedHoldingSql,
} from "@/lib/db/holding-sources";
import { LIVE_SNAPSHOT_SOURCES } from "@/lib/db/live-sources";
import { bumpIfPricesAffectSyntheticCloses, getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { routeLedgerRow } from "@/lib/queries/ledger-side-routing";
import {
  classifyPlaidHoldingRow,
  classifyPlaidPrice,
  classifyPlaidSnapshot,
  getDatingBoundary,
  getDatingSettingsRaw,
  getDatingState,
  newFormatHoldingSourceKey,
  type DatingBoundary,
  type DatingState,
} from "@/lib/plaid/session-dating";

// ── Config (the measured set) ────────────────────────────────────────────

export type AccountRole = "taxable" | "roth";
export type ConfigAccountRole = AccountRole | "both";
export type BookClass = "PRE_OPEN" | "POST_OPEN" | "CLOSED_DAY" | "UNKNOWN";
export type MeasuredBookClass = Exclude<BookClass, "PRE_OPEN">;
export type MeasuredAction = "DROP_DUPLICATE_SESSION" | "DROP_BY_RULING" | "DROP_PARTIAL_BOOK";

export interface MeasuredSetRow {
  accountRole: ConfigAccountRole;
  runDay: string;
  class: MeasuredBookClass;
  action: MeasuredAction;
}

export interface MeasuredSetConfig {
  rows: MeasuredSetRow[];
  /** First session the earlier stock/ETF price build could write a session-dated price (P3). */
  f2Since: string;
}

const CONFIG_ROLES: readonly ConfigAccountRole[] = ["taxable", "roth", "both"];
const MEASURED_CLASSES: readonly MeasuredBookClass[] = ["CLOSED_DAY", "POST_OPEN", "UNKNOWN"];
/**
 * Each measured action fits exactly one class (spec D0 table): a duplicate
 * session is a closed-day read; a ruled drop is a read finished after the
 * open; a partial book is one whose snapshot a statement replaced.
 */
const ACTION_CLASS: Readonly<Record<MeasuredAction, MeasuredBookClass>> = {
  DROP_DUPLICATE_SESSION: "CLOSED_DAY",
  DROP_BY_RULING: "POST_OPEN",
  DROP_PARTIAL_BOOK: "UNKNOWN",
};
const ROW_KEYS = ["accountRole", "runDay", "class", "action"] as const;
const TOP_KEYS = ["rows", "f2Since"] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function expandRole(role: ConfigAccountRole): AccountRole[] {
  return role === "both" ? ["taxable", "roth"] : [role];
}

/**
 * Validates the measured-set config. Throws one error listing every problem:
 * an unknown or missing field, a bad value, an action paired with the wrong
 * class, or a duplicate row (two rows that would match the same account role,
 * run day and class, "both" counting as taxable and Roth).
 */
export function validateMeasuredSetConfig(value: unknown): MeasuredSetConfig {
  const problems: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("measured-set config: the top level must be an object");
  }
  const top = value as Record<string, unknown>;
  for (const k of Object.keys(top)) {
    if (!(TOP_KEYS as readonly string[]).includes(k)) problems.push(`unknown top-level field "${k}"`);
  }
  for (const k of TOP_KEYS) if (!(k in top)) problems.push(`missing top-level field "${k}"`);
  if ("f2Since" in top && !isCalendarDate(top.f2Since)) problems.push(`f2Since must be a YYYY-MM-DD date`);

  const rows: MeasuredSetRow[] = [];
  if ("rows" in top) {
    if (!Array.isArray(top.rows)) {
      problems.push(`rows must be an array`);
    } else {
      const seen = new Map<string, number>();
      top.rows.forEach((raw, i) => {
        const where = `rows[${i}]`;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          problems.push(`${where} must be an object`);
          return;
        }
        const r = raw as Record<string, unknown>;
        let ok = true;
        for (const k of Object.keys(r)) {
          if (!(ROW_KEYS as readonly string[]).includes(k)) {
            problems.push(`${where}: unknown field "${k}"`);
            ok = false;
          }
        }
        for (const k of ROW_KEYS) {
          if (!(k in r)) {
            problems.push(`${where}: missing field "${k}"`);
            ok = false;
          }
        }
        if (!ok) return;
        if (!(CONFIG_ROLES as readonly unknown[]).includes(r.accountRole)) {
          problems.push(`${where}: accountRole must be one of ${CONFIG_ROLES.join(", ")}`);
          ok = false;
        }
        if (!isCalendarDate(r.runDay)) {
          problems.push(`${where}: runDay must be a YYYY-MM-DD date`);
          ok = false;
        }
        if (!(MEASURED_CLASSES as readonly unknown[]).includes(r.class)) {
          problems.push(`${where}: class must be one of ${MEASURED_CLASSES.join(", ")}`);
          ok = false;
        }
        if (!Object.prototype.hasOwnProperty.call(ACTION_CLASS, String(r.action))) {
          problems.push(`${where}: action must be one of ${Object.keys(ACTION_CLASS).join(", ")}`);
          ok = false;
        }
        if (!ok) return;
        const row = r as unknown as MeasuredSetRow;
        if (ACTION_CLASS[row.action] !== row.class) {
          problems.push(`${where}: action ${row.action} applies only to class ${ACTION_CLASS[row.action]}`);
          return;
        }
        for (const role of expandRole(row.accountRole)) {
          const key = `${role}|${row.runDay}|${row.class}`;
          const prior = seen.get(key);
          if (prior !== undefined) {
            problems.push(`${where}: duplicate of rows[${prior}] (${role}, ${row.runDay}, ${row.class})`);
          } else {
            seen.set(key, i);
          }
        }
        rows.push({ accountRole: row.accountRole, runDay: row.runDay, class: row.class, action: row.action });
      });
    }
  }
  if (problems.length > 0) {
    throw new Error(`measured-set config is invalid:\n  - ${problems.join("\n  - ")}`);
  }
  return { rows, f2Since: top.f2Since as string };
}

/** Parses and validates config bytes; returns the config and the SHA-256 of the bytes. */
export function parseMeasuredSetConfig(bytes: Buffer | string): { config: MeasuredSetConfig; sha256: string } {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("measured-set config is not valid JSON");
  }
  return { config: validateMeasuredSetConfig(parsed), sha256: sha256Hex(buf) };
}

// ── Manifest types ───────────────────────────────────────────────────────

export type ScopeTable = "holdings" | "monthly_snapshots" | "prices";
export type RowValue = string | number | null;
export type DbRow = Record<string, RowValue>;

export type BookAction =
  | "MOVE_BOOK"
  | "DROP_STATEMENT_TARGET"
  | "DROP_DUPLICATE_SESSION"
  | "DROP_BY_RULING"
  | "DROP_PARTIAL_BOOK"
  | "IMMUTABLE_NEW_FORMAT"
  | "BLOCK";

export type ActionCode =
  | "MOVE_BOOK"
  | "DROP_STATEMENT_TARGET"
  | "DROP_DUPLICATE_SESSION"
  | "DROP_BY_RULING"
  | "DROP_PARTIAL_BOOK"
  | "SURVIVOR_TO_ZERO"
  | "ZERO_SURVIVOR_RELABEL"
  | "SURVIVOR_CASH_EQUIVALENT_KEPT"
  | "TOMBSTONE_MOVE"
  | "TOMBSTONE_KEEP_ON_STATEMENT_DATE"
  | "TOMBSTONE_REDUNDANT"
  | "TOMBSTONE_STATEMENT_GRADE"
  | "TOMBSTONE_ON_TARGET_DATE"
  | "PRICE_FUND_SHIFT"
  | "PRICE_FUND_DROP_AUTHORITY"
  | "PRICE_NONFUND_LEGACY_DELETE"
  | "PRICE_F2_SESSION_DATED"
  | "IMMUTABLE_NEW_FORMAT"
  | "BOUNDARY_LOST"
  | "REPEAT_READ"
  | "MEASURED_SET_ROW_MISSING"
  | "PLAN_SIMULATION"
  | "BLOCK"
  | "UNCLASSIFIED";

export type LineKind = "CHANGE" | "UNCHANGED" | "IMMUTABLE_NEW_FORMAT" | "UNCLASSIFIED" | "BLOCK" | "INFO";

export interface ManifestLine {
  kind: LineKind;
  action: ActionCode;
  /** The book (`book:<account>:<runDay>`) or price rule (`price:<security>`) the line depends on. */
  rule: string;
  table?: ScopeTable;
  id?: number;
  /** Full old row (CHANGE lines). */
  old?: DbRow;
  /** Full new row, or null when the row is deleted (CHANGE lines). */
  new?: DbRow | null;
  /** All-column SHA-256 of the row (every line naming a row). */
  hash?: string;
  reason?: string;
}

export interface BookPlan {
  accountId: number;
  role: AccountRole | null;
  runDay: string;
  /** previousTradingDay(runDay): the session the read describes. */
  session: string;
  class: BookClass;
  action: BookAction;
  /** Index into the config rows, for a measured-set book. */
  configRow: number | null;
  /** For DROP_DUPLICATE_SESSION: the run day of the kept twin. */
  keptTwinRunDay: string | null;
  reason: string | null;
}

export interface ManifestBinding {
  dbPath: string;
  migrationCount: number;
  datingVersion: string | null;
  datingFirstSession: string | null;
  maxHoldingsId: number;
  maxPricesId: number;
  maxSnapshotsId: number;
  taxInputGeneration: number;
  configSha256: string;
  /** SHA-256 over every in-scope row, all columns, in (table, id) order. */
  scopeSha256: string;
}

export interface PlaidSessionDatingManifest {
  format: "plaid-session-dating-manifest/1";
  binding: ManifestBinding;
  config: MeasuredSetConfig;
  datingState: DatingState;
  books: BookPlan[];
  lines: ManifestLine[];
  predicted: {
    /** (security, date) pairs passed to bumpIfPricesAffectSyntheticCloses. */
    pricePairs: { securityId: number; date: string }[];
    bumpFires: boolean;
    taxInputGenerationAfter: number;
  };
  counts: {
    byKind: Record<string, number>;
    byAction: Record<string, number>;
    blocking: number;
  };
  /** Set by the writer; ignored when two manifests are compared. */
  generatedAt?: string;
}

/** Report-only detail (private: it may contain dates and names). */
export interface PlanReport {
  accounts: { id: number; name: string; role: AccountRole | null; reason: string | null }[];
  measuredSet: { index: number; row: MeasuredSetRow; found: { accountId: number; found: boolean }[] }[];
  repeatReads: { accountId: number; runDay: string; previousRunDay: string }[];
  statementTargets: {
    accountId: number;
    runDay: string;
    target: string;
    plaidTotal: number | null;
    statementTotal: number | null;
    ratio: number | null;
    plaidCash: number | null;
    statementCash: number | null;
    quantityDifferences: { securityId: number; plaid: number; statement: number }[];
  }[];
  /**
   * A moved book landing on the session a closed-day (weekend) statement
   * describes: every quantity that differs from that statement, and whether a
   * closing ledger row backs it (statement period up to the session). Listed,
   * never blocking; the audit's G1 judges them.
   */
  weekendStatements: {
    accountId: number;
    runDay: string;
    session: string;
    statementDate: string;
    differences: { securityId: number; plaid: number; statement: number; closingLedgerRow: boolean }[];
  }[];
  census: {
    accountId: number;
    tradeDate: string;
    type: string;
    securityId: number;
    securityKind: string | null;
    firstBookRunDay: string | null;
    firstBookClass: BookClass | null;
  }[];
  fullBookEvidence: string;
  fundPriceNote: string;
  blocks: { rule: string; reason: string }[];
}

export interface PlanResult {
  manifest: PlaidSessionDatingManifest;
  report: PlanReport;
}

// ── Hashing ──────────────────────────────────────────────────────────────

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Canonical JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** All-column SHA-256 of one row. */
export function rowHash(row: DbRow): string {
  return sha256Hex(canonicalJson(row));
}

// ── Small helpers ────────────────────────────────────────────────────────

const PLAID_HOLDING_PREFIX = "plaid:";
const PLAID_SOURCE = "plaid";
const MANUAL_SOURCE = "manual";
/**
 * Import source types the engine treats as a full holdings snapshot
 * (mirror of `HOLDINGS_SNAPSHOT_SOURCES` in lib/import/engine.ts, a local
 * constant there, plus canonical-csv, which the engine accepts when the parse
 * carried holdings). Used only for the D3 survivor evidence.
 */
const HOLDINGS_SNAPSHOT_SOURCE_TYPES = new Set([
  "vanguard-pdf",
  "vanguard-export",
  "vanguard-holdings",
  "ibkr-holdings",
  "ibkr-activity",
  "canonical-csv",
]);
const STOCK_ETF_TYPES = new Set(["stock", "etf"]);
const MUTUAL_FUND_TYPES = new Set(["mutual fund", "mutual_fund"]);
/** Relative tolerance for a statement or TWS price matching the shifted Plaid fund price (P1). */
export const FUND_PRICE_MATCH_TOLERANCE = 1e-6;
/** Shrink guard: a statement book must hold at least this share of the prior statement's rows. */
export const STATEMENT_SHRINK_FLOOR = 0.5;
/** Book-identity tolerance for quantities (DROP_DUPLICATE_SESSION). */
const QUANTITY_DIGITS = 1e6;

const TRADE_TYPES = new Set([
  "buy",
  "sell",
  "buy_to_open",
  "sell_to_open",
  "buy_to_close",
  "sell_to_close",
  "short_sell",
  "buy_to_cover",
]);

function num(v: RowValue | undefined): number {
  return typeof v === "number" ? v : Number(v);
}

function str(v: RowValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

function cents(v: RowValue | undefined): number | null {
  return v === null || v === undefined ? null : Math.round(Number(v) * 100);
}

function reconLiveKey(accountId: number, securityId: number, date: string): string {
  return `${RECON_HOLDING_SOURCE_PREFIX}${accountId}:${securityId}:${date}${RECON_LIVE_SUFFIX}`;
}

function isReconKey(key: string | null): boolean {
  return key?.startsWith(RECON_HOLDING_SOURCE_PREFIX) ?? false;
}

function isPlaidKey(key: string | null): boolean {
  return key?.startsWith(PLAID_HOLDING_PREFIX) ?? false;
}

function isStatementGradeSnapshotSource(source: string | null): boolean {
  if (source === null) return false;
  return !(LIVE_SNAPSHOT_SOURCES as readonly string[]).includes(source) && source !== MANUAL_SOURCE;
}

function isFundType(type: string | null): boolean {
  return MUTUAL_FUND_TYPES.has((type ?? "").trim().toLowerCase());
}

function isStockOrEtf(type: string | null): boolean {
  return STOCK_ETF_TYPES.has((type ?? "").trim().toLowerCase());
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z?$/;

/**
 * Parses a stored `created_at` as UTC. Accepts SQLite's `datetime('now')`
 * form and an ISO string ending in Z (or with no zone, which SQLite writes
 * in UTC). Returns null for anything else or an impossible time.
 */
export function parseUtcTimestamp(raw: string | null): Date | null {
  if (raw === null) return null;
  const m = TS_RE.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h ||
    dt.getUTCMinutes() !== mi ||
    dt.getUTCSeconds() !== s
  ) {
    return null;
  }
  return dt;
}

/**
 * D0 book class from the run day and the Plaid snapshot's `created_at`
 * (UTC, read in Eastern time with daylight saving). Null `createdAt` with
 * `hasPlaidSnapshot` false means there is no Plaid snapshot on the book.
 */
export function classifyBookClass(runDay: string, createdAt: string | null, hasPlaidSnapshot: boolean): BookClass {
  if (isMarketClosed(runDay)) return "CLOSED_DAY";
  if (!hasPlaidSnapshot) return "UNKNOWN";
  const instant = parseUtcTimestamp(createdAt);
  if (instant === null) return "UNKNOWN";
  if (todayET(instant) !== runDay) return "UNKNOWN";
  return nowET(instant) < "09:30" ? "PRE_OPEN" : "POST_OPEN";
}

// ── Loading ──────────────────────────────────────────────────────────────

interface HoldingRow {
  row: DbRow;
  id: number;
  accountId: number;
  securityId: number;
  quantity: number;
  date: string;
  key: string | null;
  statementGrade: boolean;
}

interface SnapshotRow {
  row: DbRow;
  id: number;
  accountId: number;
  date: string;
  source: string | null;
  createdAt: string | null;
  total: RowValue;
  cash: RowValue;
}

interface PriceRow {
  row: DbRow;
  id: number;
  securityId: number;
  date: string;
  close: number;
  source: string | null;
}

interface SecurityInfo {
  id: number;
  symbol: string;
  type: string | null;
  fundCategory: string | null;
}

interface PlaidAccount {
  id: number;
  name: string;
  role: AccountRole | null;
  reason: string | null;
}

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

function resolveRole(treatment: string | null): AccountRole | null {
  if (isTaxableAccount(treatment)) return "taxable";
  const t = (treatment ?? "").trim().toLowerCase();
  if (isTaxTreatment(t) && TAX_TREATMENT_LABELS[t] === TAX_TREATMENT_LABELS.roth_ira) return "roth";
  return null;
}

function loadPlaidAccounts(db: Database.Database): PlaidAccount[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.name, a.tax_treatment FROM accounts a
        WHERE EXISTS (SELECT 1 FROM monthly_snapshots ms WHERE ms.account_id = a.id AND ms.source = '${PLAID_SOURCE}')
           OR EXISTS (SELECT 1 FROM holdings h WHERE h.account_id = a.id AND h.source_key LIKE '${PLAID_HOLDING_PREFIX}%')
        ORDER BY a.id`,
    )
    .all() as { id: number; name: string; tax_treatment: string | null }[];
  const out: PlaidAccount[] = rows.map((r) => {
    const role = resolveRole(r.tax_treatment);
    return {
      id: r.id,
      name: r.name,
      role,
      reason: role === null ? "tax treatment is neither taxable nor Roth IRA" : null,
    };
  });
  for (const role of ["taxable", "roth"] as const) {
    const same = out.filter((a) => a.role === role);
    if (same.length > 1) {
      for (const a of same) a.reason = `more than one Plaid account has the ${role} role; the measured set cannot name one`;
    }
  }
  return out;
}

// ── The planner ──────────────────────────────────────────────────────────

export interface PlanOptions {
  dbPath: string;
  config: MeasuredSetConfig;
  configSha256: string;
  /**
   * Runs the plan on an in-memory copy to predict the tax generation and to
   * prove the apply would pass. Default true. Tests of the pure planner may
   * turn it off.
   */
  simulate?: boolean;
}

interface Book {
  key: string;
  accountId: number;
  runDay: string;
  snapshot: SnapshotRow | null;
  plaidRows: HoldingRow[];
  liveTombstones: HoldingRow[];
  plan: BookPlan;
}

interface RowDecision {
  table: ScopeTable;
  id: number;
  old: DbRow;
  /** undefined = unchanged; null = deleted. */
  next: DbRow | null | undefined;
  action: ActionCode;
  kind: LineKind;
  rule: string;
  reason?: string;
}

/**
 * A zero `plaid:` row that records a closure: the pair's previous stored row
 * (any source, dated before it) is non-zero. Deleting such a row without
 * carrying the closure would make the sold name read held.
 */
function isClosureZero(h: HoldingRow, holdingRows: HoldingRow[]): boolean {
  if (h.quantity !== 0) return false;
  let prev: HoldingRow | null = null;
  for (const x of holdingRows) {
    if (x.accountId !== h.accountId || x.securityId !== h.securityId || x.date >= h.date) continue;
    if (prev === null || x.date > prev.date) prev = x;
  }
  return prev !== null && prev.quantity !== 0;
}

function bookKey(accountId: number, runDay: string): string {
  return `${accountId}|${runDay}`;
}

function bookRule(accountId: number, runDay: string): string {
  return `book:${accountId}:${runDay}`;
}

/**
 * Plans the repair. Read-only on `db`. Throws when the dating settings are
 * damaged (getDatingBoundary throws), never guessing past them.
 */
export function planPlaidSessionDatingRepair(db: Database.Database, opts: PlanOptions): PlanResult {
  const { config } = opts;
  const boundary = getDatingBoundary(db);
  const datingState = getDatingState(db);
  const settingsRaw = getDatingSettingsRaw(db);

  const report: PlanReport = {
    accounts: [],
    measuredSet: [],
    repeatReads: [],
    statementTargets: [],
    weekendStatements: [],
    census: [],
    fullBookEvidence:
      "A survivor is zeroed only when every statement row of the account on that date carries a completed import " +
      "batch whose source type is a full holdings snapshot, and the batch's stored parse (raw_imports) lists holdings " +
      "for this account on that date and does not list the survivor. No stored marker says a batch carried a full " +
      "book, so this is the strongest evidence the database holds; anything missing blocks.",
    fundPriceNote:
      "P1 (owner ruling): a legacy Plaid fund price dated X holds the close of nextTradingDay(X). This is an " +
      "inference accepted from the mechanism and the statement-date checks, not a proof for every row.",
    blocks: [],
  };

  const lines: ManifestLine[] = [];
  const books: BookPlan[] = [];

  if (boundary.repaired) {
    // Version 2: nothing to repair; apply refuses.
    const manifest = finishManifest(db, opts, settingsRaw, datingState, books, lines, [], false);
    return { manifest, report };
  }

  const accounts = loadPlaidAccounts(db);
  report.accounts = accounts.map((a) => ({ id: a.id, name: a.name, role: a.role, reason: a.reason }));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountIds = accounts.map((a) => a.id);
  const idList = accountIds.length > 0 ? accountIds.join(",") : "NULL";

  // Every holdings row of the Plaid accounts (the timeline), with its statement-grade flag.
  const holdingRows: HoldingRow[] = (
    db
      .prepare(
        `SELECT h.*, ${statementGradeHoldingSql("h")} AS __sg FROM holdings h
          WHERE h.account_id IN (${idList}) ORDER BY h.id`,
      )
      .all() as (DbRow & { __sg: number })[]
  ).map((r) => {
    const { __sg, ...row } = r;
    return {
      row,
      id: num(row.id),
      accountId: num(row.account_id),
      securityId: num(row.security_id),
      quantity: num(row.quantity),
      date: String(row.as_of_date),
      key: str(row.source_key),
      statementGrade: __sg === 1,
    };
  });
  const snapshots: SnapshotRow[] = (
    db.prepare(`SELECT * FROM monthly_snapshots WHERE account_id IN (${idList}) ORDER BY id`).all() as DbRow[]
  ).map((row) => ({
    row,
    id: num(row.id),
    accountId: num(row.account_id),
    date: String(row.month_end_date),
    source: str(row.source),
    createdAt: str(row.created_at),
    total: row.total_value,
    cash: row.cash_value ?? null,
  }));
  const plaidPrices: PriceRow[] = (
    db.prepare(`SELECT * FROM prices WHERE source = '${PLAID_SOURCE}' ORDER BY id`).all() as DbRow[]
  ).map(toPriceRow);
  const priceSecurityIds = [...new Set(plaidPrices.map((p) => p.securityId))];
  const otherPrices: PriceRow[] = priceSecurityIds.length
    ? (
        db
          .prepare(
            `SELECT * FROM prices WHERE security_id IN (${priceSecurityIds.join(",")})
              AND (source IS NULL OR source != '${PLAID_SOURCE}') ORDER BY id`,
          )
          .all() as DbRow[]
      ).map(toPriceRow)
    : [];

  const securityIds = [...new Set([...holdingRows.map((h) => h.securityId), ...priceSecurityIds])];
  const securities = new Map<number, SecurityInfo>();
  if (securityIds.length > 0) {
    for (const s of db
      .prepare(`SELECT id, symbol, security_type, fund_category FROM securities WHERE id IN (${securityIds.join(",")})`)
      .all() as { id: number; symbol: string; security_type: string | null; fund_category: string | null }[]) {
      securities.set(s.id, { id: s.id, symbol: s.symbol, type: s.security_type, fundCategory: s.fund_category });
    }
  }
  const isCashEq = (securityId: number): boolean => {
    const s = securities.get(securityId);
    return s ? isCashEquivalentSecurity({ security_type: s.type, fund_category: s.fundCategory }) : false;
  };

  // Indexes.
  const rowsOn = new Map<string, HoldingRow[]>(); // account|date -> rows
  for (const h of holdingRows) {
    const k = bookKey(h.accountId, h.date);
    const list = rowsOn.get(k) ?? [];
    list.push(h);
    rowsOn.set(k, list);
  }
  const snapshotOn = new Map<string, SnapshotRow>();
  for (const s of snapshots) snapshotOn.set(bookKey(s.accountId, s.date), s);
  const isStatementRow = (h: HoldingRow): boolean => h.statementGrade && !isReconKey(h.key);
  const statementRowsOn = (a: number, d: string): HoldingRow[] =>
    (rowsOn.get(bookKey(a, d)) ?? []).filter(isStatementRow);
  /** Rows on (a, d) that are neither Plaid, statement nor recon (TWS, manual, unknown, null key). */
  const otherRowsOn = (a: number, d: string): HoldingRow[] =>
    (rowsOn.get(bookKey(a, d)) ?? []).filter((h) => !isPlaidKey(h.key) && !isReconKey(h.key) && !isStatementRow(h));

  // ── Books ─────────────────────────────────────────────────────────────
  const bookMap = new Map<string, Book>();
  const ensureBook = (a: number, d: string): Book => {
    const k = bookKey(a, d);
    let b = bookMap.get(k);
    if (!b) {
      const role = accountById.get(a)?.role ?? null;
      b = {
        key: k,
        accountId: a,
        runDay: d,
        snapshot: null,
        plaidRows: [],
        liveTombstones: [],
        plan: {
          accountId: a,
          role,
          runDay: d,
          session: previousTradingDay(d),
          class: "UNKNOWN",
          action: "BLOCK",
          configRow: null,
          keptTwinRunDay: null,
          reason: null,
        },
      };
      bookMap.set(k, b);
    }
    return b;
  };
  for (const s of snapshots) if (s.source === PLAID_SOURCE) ensureBook(s.accountId, s.date).snapshot = s;
  for (const h of holdingRows) if (isPlaidKey(h.key)) ensureBook(h.accountId, h.date).plaidRows.push(h);
  for (const b of bookMap.values()) {
    b.liveTombstones = (rowsOn.get(b.key) ?? []).filter((h) => isReconKey(h.key) && !h.statementGrade);
  }
  const bookList = [...bookMap.values()].sort(
    (x, y) => x.runDay.localeCompare(y.runDay) || x.accountId - y.accountId,
  );
  const booksByAccount = new Map<number, Book[]>();
  for (const b of bookList) {
    const list = booksByAccount.get(b.accountId) ?? [];
    list.push(b);
    booksByAccount.set(b.accountId, list);
  }

  const blockBook = (b: Book, reason: string): void => {
    if (b.plan.action !== "BLOCK" || b.plan.reason === null) {
      b.plan.action = "BLOCK";
      b.plan.reason = reason;
    }
  };

  // Format per book (section B).
  const formatOfBook = (b: Book): "new" | "legacy" | "mixed" => {
    const formats = new Set<string>();
    if (b.snapshot) formats.add(classifyPlaidSnapshot(b.accountId, b.runDay, boundary));
    for (const h of [...b.plaidRows, ...b.liveTombstones]) {
      formats.add(classifyPlaidHoldingRow({ accountId: h.accountId, asOfDate: h.date, sourceKey: h.key }, boundary) ?? "legacy");
    }
    if (formats.size === 1) return formats.has("new") ? "new" : "legacy";
    return "mixed";
  };

  // Pass 1: class and book-level action for PRE_OPEN books; measured-set match for the rest.
  for (const b of bookList) {
    const account = accountById.get(b.accountId);
    const fmt = formatOfBook(b);
    b.plan.class = classifyBookClass(b.runDay, b.snapshot?.createdAt ?? null, b.snapshot !== null);
    if (fmt === "new") {
      b.plan.action = "IMMUTABLE_NEW_FORMAT";
      continue;
    }
    if (fmt === "mixed") {
      blockBook(b, "the book mixes new-format and legacy rows");
      continue;
    }
    if (!account || account.reason) {
      blockBook(b, account?.reason ?? "account not resolved");
      continue;
    }
    const d = b.runDay;
    const t = b.plan.session;
    const ownStatement = statementRowsOn(b.accountId, d);
    const ownStatementGradeTombstones = (rowsOn.get(b.key) ?? []).filter((h) => isReconKey(h.key) && h.statementGrade);
    const ownOther = otherRowsOn(b.accountId, d);

    if (b.plan.class === "PRE_OPEN") {
      if (ownStatement.length > 0 || ownStatementGradeTombstones.length > 0) {
        blockBook(b, "a PRE_OPEN book shares its run day with statement rows");
        continue;
      }
      if (ownOther.length > 0) {
        blockBook(b, "a PRE_OPEN book shares its run day with TWS, manual or unknown holdings rows");
        continue;
      }
      const tSnap = snapshotOn.get(bookKey(b.accountId, t)) ?? null;
      if (otherRowsOn(b.accountId, t).length > 0 || (tSnap && (tSnap.source === "tws" || tSnap.source === MANUAL_SOURCE || tSnap.source === null))) {
        blockBook(b, "the target session holds a TWS or manual book");
        continue;
      }
      if (statementRowsOn(b.accountId, t).length > 0 || (tSnap && isStatementGradeSnapshotSource(tSnap.source))) {
        b.plan.action = "DROP_STATEMENT_TARGET";
      } else {
        b.plan.action = "MOVE_BOOK";
      }
      continue;
    }

    // A non-PRE_OPEN book must match one measured-set row.
    const matches = config.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          row.runDay === d &&
          row.class === b.plan.class &&
          account.role !== null &&
          expandRole(row.accountRole).includes(account.role),
      );
    if (matches.length !== 1) {
      blockBook(b, `${b.plan.class} book not in the measured set`);
      continue;
    }
    const { row, index } = matches[0];
    b.plan.configRow = index;
    b.plan.action = row.action;
    if (row.action !== "DROP_PARTIAL_BOOK") {
      if (ownStatement.length > 0 || ownStatementGradeTombstones.length > 0) {
        blockBook(b, `${row.action} book shares its run day with statement rows`);
        continue;
      }
      if (ownOther.length > 0) {
        blockBook(b, `${row.action} book shares its run day with TWS, manual or unknown holdings rows`);
        continue;
      }
    }
    if (row.action === "DROP_BY_RULING" && b.liveTombstones.length > 0) {
      blockBook(b, "a tombstone on a ruled drop (its closure would be delayed)");
      continue;
    }
    // A zero Plaid row that records a closure is treated exactly like a
    // tombstone. (DROP_DUPLICATE_SESSION needs no such check: its identity
    // check compares every Plaid row, zeros included, so the kept twin holds
    // the same zero and carries the closure to the same session.)
    if (row.action === "DROP_BY_RULING" && b.plaidRows.some((h) => isClosureZero(h, holdingRows))) {
      blockBook(b, "a zero Plaid row recording a closure on a ruled drop (its closure would be lost)");
      continue;
    }
    if (row.action === "DROP_PARTIAL_BOOK") {
      if (ownStatement.length === 0) {
        blockBook(b, "DROP_PARTIAL_BOOK requires statement rows on the run day");
        continue;
      }
      if (b.snapshot !== null) {
        blockBook(b, "DROP_PARTIAL_BOOK found a Plaid snapshot on the run day");
        continue;
      }
      if (b.liveTombstones.length > 0) {
        blockBook(b, "a live tombstone on a partial book is not covered");
        continue;
      }
      if (ownOther.length > 0) {
        blockBook(b, "a partial book shares its run day with TWS, manual or unknown holdings rows");
        continue;
      }
    }
  }

  // Pass 2: duplicate-session books need their kept twin.
  const positionSet = (rows: HoldingRow[]): string[] =>
    rows.map((h) => `${h.securityId}:${Math.round(h.quantity * QUANTITY_DIGITS)}`).sort();
  for (const b of bookList) {
    if (b.plan.action !== "DROP_DUPLICATE_SESSION") continue;
    const list = booksByAccount.get(b.accountId) ?? [];
    const twin = list.find((x) => x.runDay > b.runDay) ?? null;
    if (!twin) {
      blockBook(b, "no kept twin: no later book on the account");
      continue;
    }
    b.plan.keptTwinRunDay = twin.runDay;
    if (twin.plan.class !== "PRE_OPEN" || twin.plan.action !== "MOVE_BOOK") {
      blockBook(b, "the kept twin is not a PRE_OPEN book that moves");
      continue;
    }
    if (twin.plan.session !== b.plan.session) {
      blockBook(b, "the kept twin describes a different session");
      continue;
    }
    if (!b.snapshot || !twin.snapshot) {
      blockBook(b, "a duplicate-session book or its twin has no Plaid snapshot");
      continue;
    }
    if (cents(b.snapshot.total) !== cents(twin.snapshot.total)) {
      blockBook(b, "duplicate not identical: total differs from the kept twin");
      continue;
    }
    if (cents(b.snapshot.cash) !== cents(twin.snapshot.cash)) {
      blockBook(b, "duplicate not identical: cash differs from the kept twin");
      continue;
    }
    const a1 = positionSet(b.plaidRows);
    const a2 = positionSet(twin.plaidRows);
    if (a1.length !== a2.length || a1.some((v, i) => v !== a2[i])) {
      blockBook(b, "duplicate not identical: positions differ from the kept twin");
      continue;
    }
  }

  // Pass 3: survivors of partial books (independent of the timeline).
  const survivorDecisions = new Map<number, { action: ActionCode; next: DbRow | undefined; reason?: string }>();
  const evidenceCache = new Map<string, FullBookEvidence>();
  for (const b of bookList) {
    if (b.plan.action !== "DROP_PARTIAL_BOOK") continue;
    const account = accountById.get(b.accountId);
    for (const h of b.plaidRows) {
      if (isCashEq(h.securityId)) {
        survivorDecisions.set(h.id, { action: "SURVIVOR_CASH_EQUIVALENT_KEPT", next: undefined });
        continue;
      }
      if (h.quantity === 0) {
        survivorDecisions.set(h.id, {
          action: "ZERO_SURVIVOR_RELABEL",
          next: { ...h.row, source_key: reconLiveKey(h.accountId, h.securityId, b.runDay) },
        });
        continue;
      }
      const evKey = b.key;
      let ev = evidenceCache.get(evKey);
      if (!ev) {
        ev = fullStatementBookEvidence(db, b.accountId, account?.name ?? "", b.runDay, holdingRows);
        evidenceCache.set(evKey, ev);
      }
      const symbol = securities.get(h.securityId)?.symbol ?? null;
      let reason: string | null = null;
      if (!ev.ok) reason = `survivor on a statement book that is not proven full: ${ev.reason}`;
      else if (ev.priorStatementDate === null) reason = "survivor: no prior statement to bound the closing ledger row";
      else if (symbol === null || ev.parsedSymbols.has(symbol.trim().toUpperCase())) reason = "survivor: the statement lists it";
      else if (!hasClosingLedgerRow(db, b.accountId, h.securityId, ev.priorStatementDate, b.runDay)) {
        reason = "survivor without a closing ledger row in the statement period";
      }
      if (reason) {
        survivorDecisions.set(h.id, { action: "BLOCK", next: undefined, reason });
        blockBook(b, reason);
        continue;
      }
      survivorDecisions.set(h.id, {
        action: "SURVIVOR_TO_ZERO",
        next: {
          ...h.row,
          quantity: 0,
          cost_basis: 0,
          source_key: reconLiveKey(h.accountId, h.securityId, b.runDay),
          import_batch_id: null,
        },
      });
    }
  }

  // Pass 4: row decisions on the planned timeline, iterated until no new block.
  let decisions: RowDecision[] = [];
  for (let iter = 0; iter < 100; iter++) {
    const before = bookList.filter((b) => b.plan.action === "BLOCK").length;
    // A blocked kept twin blocks its duplicate (its tombstones have nowhere to go).
    for (const b of bookList) {
      if (b.plan.action !== "DROP_DUPLICATE_SESSION" || !b.plan.keptTwinRunDay) continue;
      const twin = bookMap.get(bookKey(b.accountId, b.plan.keptTwinRunDay));
      if (twin && twin.plan.action === "BLOCK") blockBook(b, "the kept twin is blocked");
    }
    decisions = planHoldingAndSnapshotRows(bookList, survivorDecisions, holdingRows, statementRowsOn, blockBook);
    checkTimeline(decisions, holdingRows, snapshots, bookList, blockBook, db);
    const after = bookList.filter((b) => b.plan.action === "BLOCK").length;
    if (after === before) break;
  }

  // In-scope tombstones not on a book: those on a date a move reaches.
  const targetSlots = new Set<string>();
  for (const dec of decisions) {
    if (dec.table === "holdings" && dec.next) targetSlots.add(bookKey(num(dec.next.account_id), String(dec.next.as_of_date)));
    if (dec.table === "monthly_snapshots" && dec.next) targetSlots.add(bookKey(num(dec.next.account_id), String(dec.next.month_end_date)));
  }
  const decided = new Set(decisions.filter((x) => x.table === "holdings").map((x) => x.id));
  for (const h of holdingRows) {
    if (!isReconKey(h.key) || decided.has(h.id)) continue;
    const k = bookKey(h.accountId, h.date);
    const onBookDate = bookMap.has(k);
    if (!onBookDate && !targetSlots.has(k)) continue; // out of scope
    const fmt = classifyPlaidHoldingRow({ accountId: h.accountId, asOfDate: h.date, sourceKey: h.key }, boundary);
    if (fmt === "new") {
      decisions.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule: bookRule(h.accountId, h.date) });
    } else if (h.statementGrade) {
      decisions.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "TOMBSTONE_STATEMENT_GRADE", kind: "UNCHANGED", rule: bookRule(h.accountId, h.date) });
    } else {
      decisions.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "TOMBSTONE_ON_TARGET_DATE", kind: "UNCHANGED", rule: bookRule(h.accountId, h.date) });
    }
  }

  // Books -> manifest lines.
  for (const b of bookList) books.push({ ...b.plan });
  for (const b of bookList) {
    if (b.plan.action === "BLOCK") report.blocks.push({ rule: bookRule(b.accountId, b.runDay), reason: b.plan.reason ?? "blocked" });
  }

  // Measured set: every row must be found on every account it names.
  config.rows.forEach((row, index) => {
    const found: { accountId: number; found: boolean }[] = [];
    for (const role of expandRole(row.accountRole)) {
      const acct = accounts.filter((a) => a.role === role);
      if (acct.length === 0) {
        found.push({ accountId: 0, found: false });
        lines.push({ kind: "BLOCK", action: "MEASURED_SET_ROW_MISSING", rule: `config:${index}`, reason: `no Plaid account with the ${role} role` });
        continue;
      }
      for (const a of acct) {
        const b = bookMap.get(bookKey(a.id, row.runDay));
        const ok = b !== undefined && b.plan.class === row.class && b.plan.configRow === index;
        found.push({ accountId: a.id, found: ok });
        if (!ok) {
          lines.push({
            kind: "BLOCK",
            action: "MEASURED_SET_ROW_MISSING",
            rule: `config:${index}`,
            reason: `measured-set row ${index} (${role}) not found as a ${row.class} book`,
          });
        }
      }
    }
    report.measuredSet.push({ index, row, found });
  });

  // Mixed state: the first new-format write overwrote the legacy book of run day S0.
  for (const [accountId, s0] of boundary.accounts) {
    lines.push({
      kind: "INFO",
      action: "BOUNDARY_LOST",
      rule: `account:${accountId}`,
      reason: `the legacy book of run day ${s0} was overwritten; session ${previousTradingDay(s0)} carries the previous book`,
    });
  }

  // Repeat reads among consecutive legacy books (listed, never blocking).
  for (const [accountId, list] of booksByAccount) {
    for (let i = 1; i < list.length; i++) {
      const older = list[i - 1];
      const newer = list[i];
      if (!older.snapshot || !newer.snapshot) continue;
      if (cents(older.snapshot.total) !== cents(newer.snapshot.total)) continue;
      if (cents(older.snapshot.cash) !== cents(newer.snapshot.cash)) continue;
      const nz = (rows: HoldingRow[]) => positionSet(rows.filter((h) => h.quantity !== 0));
      const p1 = nz(older.plaidRows);
      const p2 = nz(newer.plaidRows);
      if (p1.length !== p2.length || p1.some((v, j) => v !== p2[j])) continue;
      if (!newer.plaidRows.some((h) => h.quantity !== 0 && !isCashEq(h.securityId))) continue;
      report.repeatReads.push({ accountId, runDay: newer.runDay, previousRunDay: older.runDay });
      lines.push({ kind: "INFO", action: "REPEAT_READ", rule: bookRule(accountId, newer.runDay), reason: `identical to the book of run day ${older.runDay}` });
    }
  }

  // Statement-target comparisons (report only).
  for (const b of bookList) {
    if (b.plan.action !== "DROP_STATEMENT_TARGET") continue;
    const t = b.plan.session;
    const stmtSnap = snapshotOn.get(bookKey(b.accountId, t)) ?? null;
    const stmtRows = statementRowsOn(b.accountId, t);
    const stmtQty = new Map(stmtRows.map((h) => [h.securityId, h.quantity]));
    const plaidQty = new Map(b.plaidRows.map((h) => [h.securityId, h.quantity]));
    const diffs: { securityId: number; plaid: number; statement: number }[] = [];
    for (const id of new Set([...stmtQty.keys(), ...plaidQty.keys()])) {
      const p = plaidQty.get(id) ?? 0;
      const s = stmtQty.get(id) ?? 0;
      if (Math.abs(p - s) > 1e-6) diffs.push({ securityId: id, plaid: p, statement: s });
    }
    const plaidTotal = b.snapshot ? num(b.snapshot.total) : null;
    const statementTotal = stmtSnap && isStatementGradeSnapshotSource(stmtSnap.source) ? num(stmtSnap.total) : null;
    report.statementTargets.push({
      accountId: b.accountId,
      runDay: b.runDay,
      target: t,
      plaidTotal,
      statementTotal,
      ratio: plaidTotal !== null && statementTotal ? plaidTotal / statementTotal : null,
      plaidCash: b.snapshot && b.snapshot.cash !== null ? num(b.snapshot.cash) : null,
      statementCash: stmtSnap && isStatementGradeSnapshotSource(stmtSnap.source) && stmtSnap.cash !== null ? num(stmtSnap.cash) : null,
      quantityDifferences: diffs.sort((x, y) => x.securityId - y.securityId),
    });
  }

  // Moved books onto the session a weekend statement describes (report only).
  const statementDatesByAccount = new Map<number, string[]>();
  for (const h of holdingRows) {
    if (!isStatementRow(h)) continue;
    const list = statementDatesByAccount.get(h.accountId) ?? [];
    if (!list.includes(h.date)) list.push(h.date);
    statementDatesByAccount.set(h.accountId, list);
  }
  for (const list of statementDatesByAccount.values()) list.sort();
  for (const b of bookList) {
    if (b.plan.action !== "MOVE_BOOK") continue;
    const dates = statementDatesByAccount.get(b.accountId) ?? [];
    const m = dates.find((d) => isMarketClosed(d) && previousTradingDay(d) === b.plan.session);
    if (!m) continue;
    const prior = [...dates].reverse().find((d) => d < m) ?? "0000-00-00";
    const stmtQty = new Map(statementRowsOn(b.accountId, m).map((h) => [h.securityId, h.quantity]));
    const plaidQty = new Map(b.plaidRows.map((h) => [h.securityId, h.quantity]));
    const differences: PlanReport["weekendStatements"][number]["differences"] = [];
    for (const id of [...new Set([...stmtQty.keys(), ...plaidQty.keys()])].sort((x, y) => x - y)) {
      const p = plaidQty.get(id) ?? 0;
      const q = stmtQty.get(id) ?? 0;
      if (Math.abs(p - q) <= 1e-6) continue;
      differences.push({
        securityId: id,
        plaid: p,
        statement: q,
        closingLedgerRow: hasClosingLedgerRow(db, b.accountId, id, prior, b.plan.session),
      });
    }
    report.weekendStatements.push({ accountId: b.accountId, runDay: b.runDay, session: b.plan.session, statementDate: m, differences });
  }

  // ── Prices (D5) ───────────────────────────────────────────────────────
  const preOpenSessions = new Set(
    bookList.filter((b) => b.plan.class === "PRE_OPEN").map((b) => b.plan.session),
  );
  const eraStart = bookList.length > 0 ? previousTradingDay(bookList[0].runDay) : null;
  const priceDecisions = planPrices(plaidPrices, otherPrices, securities, boundary, config.f2Since, preOpenSessions, eraStart);
  for (const p of priceDecisions) {
    if (p.kind === "BLOCK") report.blocks.push({ rule: p.rule, reason: p.reason ?? "blocked" });
  }

  // Census of traced trades (report only).
  report.census = tradeCensus(db, accountIds, bookList, holdingRows);

  // ── Lines ─────────────────────────────────────────────────────────────
  const allDecisions = [...decisions, ...priceDecisions];
  for (const dec of allDecisions) {
    const line: ManifestLine = { kind: dec.kind, action: dec.action, rule: dec.rule, table: dec.table, id: dec.id, hash: rowHash(dec.old) };
    if (dec.kind === "CHANGE") {
      line.old = dec.old;
      line.new = dec.next ?? null;
    }
    if (dec.reason) line.reason = dec.reason;
    lines.push(line);
  }

  // Safety net: every in-scope row has exactly one line.
  const lineKeys = new Map<string, number>();
  for (const l of lines) {
    if (l.table && l.id !== undefined) {
      const k = `${l.table}:${l.id}`;
      lineKeys.set(k, (lineKeys.get(k) ?? 0) + 1);
    }
  }
  const scopeRows: { table: ScopeTable; row: DbRow }[] = [
    ...holdingRows.filter((h) => isPlaidKey(h.key)).map((h) => ({ table: "holdings" as const, row: h.row })),
    ...snapshots.filter((s) => s.source === PLAID_SOURCE).map((s) => ({ table: "monthly_snapshots" as const, row: s.row })),
    ...plaidPrices.map((p) => ({ table: "prices" as const, row: p.row })),
  ];
  for (const { table, row } of scopeRows) {
    const k = `${table}:${num(row.id)}`;
    const n = lineKeys.get(k) ?? 0;
    if (n === 0) {
      lines.push({ kind: "UNCLASSIFIED", action: "UNCLASSIFIED", rule: "none", table, id: num(row.id), hash: rowHash(row) });
    } else if (n > 1) {
      lines.push({ kind: "BLOCK", action: "BLOCK", rule: "planner", table, id: num(row.id), hash: rowHash(row), reason: "the planner gave this row more than one line" });
    }
  }

  // Order: CHANGE lines in book order (already), prices newest first per security (planPrices).
  const pricePairs = collectPricePairs(lines);
  let manifest = finishManifest(db, opts, settingsRaw, datingState, books, lines, pricePairs, false);

  if (opts.simulate !== false && manifest.counts.blocking === 0) {
    const sim = simulateApply(db, manifest);
    if (sim.error) {
      lines.push({ kind: "BLOCK", action: "PLAN_SIMULATION", rule: "planner", reason: `the apply would fail on a copy: ${sim.error}` });
      report.blocks.push({ rule: "planner", reason: `simulation: ${sim.error}` });
    }
    manifest = finishManifest(db, opts, settingsRaw, datingState, books, lines, pricePairs, sim.bumpFires, sim.generationAfter);
  }
  return { manifest, report };
}

function toPriceRow(row: DbRow): PriceRow {
  return {
    row,
    id: num(row.id),
    securityId: num(row.security_id),
    date: String(row.date),
    close: num(row.close_price),
    source: str(row.source),
  };
}

function planHoldingAndSnapshotRows(
  bookList: Book[],
  survivorDecisions: Map<number, { action: ActionCode; next: DbRow | undefined; reason?: string }>,
  holdingRows: HoldingRow[],
  statementRowsOn: (a: number, d: string) => HoldingRow[],
  blockBook: (b: Book, reason: string) => void,
): RowDecision[] {
  const out: RowDecision[] = [];
  const blockedRows = (b: Book) => {
    const reason = b.plan.reason ?? "book blocked";
    const rule = bookRule(b.accountId, b.runDay);
    if (b.snapshot) out.push({ table: "monthly_snapshots", id: b.snapshot.id, old: b.snapshot.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason });
    for (const h of [...b.plaidRows, ...b.liveTombstones]) {
      out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason });
    }
  };

  // First the non-tombstone rows of every book, so tombstone slot checks see final survivors.
  const pending: { b: Book; h: HoldingRow }[] = [];
  for (const b of bookList) {
    const rule = bookRule(b.accountId, b.runDay);
    const a = b.plan.action;
    if (a === "BLOCK") {
      blockedRows(b);
      continue;
    }
    if (a === "IMMUTABLE_NEW_FORMAT") {
      if (b.snapshot) out.push({ table: "monthly_snapshots", id: b.snapshot.id, old: b.snapshot.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule });
      for (const h of [...b.plaidRows, ...b.liveTombstones]) {
        out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule });
      }
      continue;
    }
    const t = b.plan.session;
    if (a === "MOVE_BOOK") {
      if (b.snapshot) out.push({ table: "monthly_snapshots", id: b.snapshot.id, old: b.snapshot.row, next: { ...b.snapshot.row, month_end_date: t }, action: "MOVE_BOOK", kind: "CHANGE", rule });
      for (const h of b.plaidRows) {
        out.push({
          table: "holdings",
          id: h.id,
          old: h.row,
          next: { ...h.row, as_of_date: t, source_key: newFormatHoldingSourceKey(h.accountId, h.securityId, t) },
          action: "MOVE_BOOK",
          kind: "CHANGE",
          rule,
        });
      }
    } else if (a === "DROP_STATEMENT_TARGET" || a === "DROP_DUPLICATE_SESSION" || a === "DROP_BY_RULING") {
      if (b.snapshot) out.push({ table: "monthly_snapshots", id: b.snapshot.id, old: b.snapshot.row, next: null, action: a, kind: "CHANGE", rule });
      for (const h of b.plaidRows) out.push({ table: "holdings", id: h.id, old: h.row, next: null, action: a, kind: "CHANGE", rule });
    } else if (a === "DROP_PARTIAL_BOOK") {
      for (const h of b.plaidRows) {
        const s = survivorDecisions.get(h.id);
        if (!s || s.action === "BLOCK") {
          out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason: s?.reason ?? "survivor not decided" });
          continue;
        }
        if (s.next === undefined) {
          out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: s.action, kind: "UNCHANGED", rule });
        } else {
          out.push({ table: "holdings", id: h.id, old: h.row, next: s.next, action: s.action, kind: "CHANGE", rule });
        }
      }
    }
    for (const h of b.liveTombstones) pending.push({ b, h });
  }

  // Tombstones (D4), on the planned slots. `finalAt` holds what each
  // (account, security, date) slot will hold: rows no book decides stay where
  // they are; decided rows sit at their final slot; pending tombstones are
  // added as they are decided (oldest book first, so a tombstone already on
  // a target date has been decided before anything lands there).
  const decidedIds = new Set<number>();
  for (const b of bookList) for (const h of [...b.plaidRows, ...b.liveTombstones]) decidedIds.add(h.id);
  const finalAt = new Map<string, { quantity: number; action: string }>();
  const slotOf = (r: DbRow) => `${num(r.account_id)}|${num(r.security_id)}|${String(r.as_of_date)}`;
  for (const h of holdingRows) {
    if (decidedIds.has(h.id)) continue;
    finalAt.set(`${h.accountId}|${h.securityId}|${h.date}`, {
      quantity: h.quantity,
      action: isReconKey(h.key) ? (h.statementGrade ? "TOMBSTONE_STATEMENT_GRADE" : "TOMBSTONE") : "ROW",
    });
  }
  const place = (dec: RowDecision) => {
    if (dec.table !== "holdings") return;
    const row = dec.kind === "CHANGE" ? dec.next : dec.old;
    if (!row) return;
    finalAt.set(slotOf(row), { quantity: num(row.quantity), action: dec.action });
  };
  for (const dec of out) place(dec);

  // A book dropped onto a statement date deletes its Plaid rows. A zero row
  // there that records a closure is safe to delete only when the statement on
  // t names the security (the statement wins) or the planned t slot already
  // holds a zero; otherwise the closure would be lost: BLOCK.
  for (const b of bookList) {
    if (b.plan.action !== "DROP_STATEMENT_TARGET") continue;
    const t = b.plan.session;
    for (const h of b.plaidRows) {
      if (!isClosureZero(h, holdingRows)) continue;
      if (statementRowsOn(b.accountId, t).some((x) => x.securityId === h.securityId)) continue;
      if (finalAt.get(`${h.accountId}|${h.securityId}|${t}`)?.quantity === 0) continue;
      blockBook(b, "a zero Plaid row recording a closure would be lost when the book drops onto the statement date");
    }
  }

  for (const { b, h } of pending) {
    const n = out.length;
    decideTombstone(b, h);
    for (let i = n; i < out.length; i++) place(out[i]);
  }
  return out;

  function decideTombstone(b: Book, h: HoldingRow): void {
    const rule = bookRule(b.accountId, b.runDay);
    const a = b.plan.action;
    const t = b.plan.session;
    const slot = `${h.accountId}|${h.securityId}|${t}`;
    const moved: DbRow = { ...h.row, as_of_date: t, source_key: reconLiveKey(h.accountId, h.securityId, t) };
    if (a === "MOVE_BOOK") {
      out.push({ table: "holdings", id: h.id, old: h.row, next: moved, action: "TOMBSTONE_MOVE", kind: "CHANGE", rule });
    } else if (a === "DROP_DUPLICATE_SESSION") {
      const twinRunDay = b.plan.keptTwinRunDay;
      const twinTombstone = twinRunDay
        ? holdingRows.find(
            (x) =>
              x.accountId === b.accountId &&
              x.date === twinRunDay &&
              isReconKey(x.key) &&
              !x.statementGrade &&
              x.securityId === h.securityId,
          )
        : undefined;
      if (twinTombstone) {
        out.push({ table: "holdings", id: h.id, old: h.row, next: null, action: "TOMBSTONE_REDUNDANT", kind: "CHANGE", rule, reason: "the kept twin records the same closure" });
      } else {
        out.push({ table: "holdings", id: h.id, old: h.row, next: moved, action: "TOMBSTONE_MOVE", kind: "CHANGE", rule });
      }
    } else if (a === "DROP_STATEMENT_TARGET") {
      const stmtHolds = statementRowsOn(b.accountId, t).find((x) => x.securityId === h.securityId);
      if (stmtHolds && stmtHolds.quantity !== 0) {
        const reason = "the statement on the target date holds the security non-zero";
        blockBook(b, reason);
        out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason });
      } else if (finalAt.get(slot)?.quantity === 0) {
        out.push({ table: "holdings", id: h.id, old: h.row, next: null, action: "TOMBSTONE_REDUNDANT", kind: "CHANGE", rule, reason: `the target slot already records the closure (${finalAt.get(slot)?.action})` });
      } else if (finalAt.has(slot)) {
        const reason = "the target slot holds the security non-zero";
        blockBook(b, reason);
        out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason });
      } else {
        out.push({ table: "holdings", id: h.id, old: h.row, next: moved, action: "TOMBSTONE_KEEP_ON_STATEMENT_DATE", kind: "CHANGE", rule });
      }
    } else {
      const reason = `a tombstone on a ${a} book is not covered`;
      blockBook(b, reason);
      out.push({ table: "holdings", id: h.id, old: h.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason });
    }
  }
}

/**
 * Validates the complete planned timeline (D4 and the unique constraints):
 *  - no two surviving holdings rows share (account, security, date) or a
 *    source key; no two snapshots share (account, date);
 *  - per (account, security), surviving rows keep their order (p < t < n);
 *  - no row moves to a later date (no closure is delayed).
 * An offending row blocks its book.
 */
function checkTimeline(
  decisions: RowDecision[],
  holdingRows: HoldingRow[],
  snapshots: SnapshotRow[],
  bookList: Book[],
  blockBook: (b: Book, reason: string) => void,
  db: Database.Database,
): void {
  const bookOfRule = new Map(bookList.map((b) => [bookRule(b.accountId, b.runDay), b]));
  const decByHolding = new Map<number, RowDecision>();
  const decBySnapshot = new Map<number, RowDecision>();
  for (const d of decisions) {
    if (d.table === "holdings") decByHolding.set(d.id, d);
    if (d.table === "monthly_snapshots") decBySnapshot.set(d.id, d);
  }
  const blockRule = (rule: string | undefined, reason: string) => {
    if (!rule) return;
    const b = bookOfRule.get(rule);
    if (b) blockBook(b, reason);
  };

  // Holdings.
  type Final = { h: HoldingRow; date: string; key: string | null; quantity: number; rule?: string };
  const finals: Final[] = [];
  for (const h of holdingRows) {
    const dec = decByHolding.get(h.id);
    if (dec && dec.next === null && dec.kind === "CHANGE") continue; // deleted
    const row = dec && dec.kind === "CHANGE" && dec.next ? dec.next : h.row;
    finals.push({ h, date: String(row.as_of_date), key: str(row.source_key), quantity: num(row.quantity), rule: dec?.rule });
    if (dec && dec.kind === "CHANGE" && dec.next && String(dec.next.as_of_date) > h.date) {
      blockRule(dec.rule, "a row would move to a later date");
    }
  }
  const slotSeen = new Map<string, Final>();
  for (const f of finals) {
    const k = `${f.h.accountId}|${f.h.securityId}|${f.date}`;
    const prev = slotSeen.get(k);
    if (prev) {
      blockRule(f.rule, "two rows would share one (account, security, date) slot");
      blockRule(prev.rule, "two rows would share one (account, security, date) slot");
    } else {
      slotSeen.set(k, f);
    }
  }
  // Source keys: against every key in the database (other accounts too).
  const changedIds = new Set(decisions.filter((d) => d.table === "holdings" && d.kind === "CHANGE").map((d) => d.id));
  const keyOwner = db.prepare(`SELECT id FROM holdings WHERE source_key = ?`);
  const newKeys = new Map<string, Final>();
  for (const f of finals) {
    const dec = decByHolding.get(f.h.id);
    if (!dec || dec.kind !== "CHANGE" || f.key === null || f.key === f.h.key) continue;
    const other = newKeys.get(f.key);
    if (other) {
      blockRule(f.rule, "two rows would share one source key");
      blockRule(other.rule, "two rows would share one source key");
      continue;
    }
    newKeys.set(f.key, f);
    const owner = keyOwner.get(f.key) as { id: number } | undefined;
    if (owner && owner.id !== f.h.id && !changedIds.has(owner.id)) {
      blockRule(f.rule, "the new source key is already used by another row");
    }
  }
  // Order per pair, read by session (coordinator ruling on the rehearsal):
  // a statement-grade row dated on a closed day M (a weekend month-end)
  // describes the close of previousTradingDay(M), its effective session. A
  // non-statement row whose final date IS that session may sit on either side
  // of it: the Plaid row on the trading day and the statement dated later
  // hold the same close. Every other tie or inversion is a reorder.
  const effective = (f: Final): string =>
    f.h.statementGrade && isMarketClosed(f.date) ? previousTradingDay(f.date) : f.date;
  const isClosedDayStatement = (f: Final): boolean => f.h.statementGrade && isMarketClosed(f.date);
  const sameCloseTie = (a: Final, b: Final): boolean => {
    if (effective(a) !== effective(b)) return false;
    const [stmt, other] = isClosedDayStatement(a) ? [a, b] : [b, a];
    return isClosedDayStatement(stmt) && !other.h.statementGrade && other.date === effective(stmt);
  };
  const byPair = new Map<string, Final[]>();
  for (const f of finals) {
    const k = `${f.h.accountId}|${f.h.securityId}`;
    const list = byPair.get(k) ?? [];
    list.push(f);
    byPair.set(k, list);
  }
  for (const list of byPair.values()) {
    list.sort((x, y) => x.h.date.localeCompare(y.h.date));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (effective(a) < effective(b) || sameCloseTie(a, b)) continue;
      blockRule(b.rule, "a move would reorder a position's history");
      blockRule(a.rule, "a move would reorder a position's history");
    }
  }

  // Snapshots.
  const snapSlot = new Map<string, { rule?: string }>();
  for (const s of snapshots) {
    const dec = decBySnapshot.get(s.id);
    if (dec && dec.kind === "CHANGE" && dec.next === null) continue;
    const date = dec && dec.kind === "CHANGE" && dec.next ? String(dec.next.month_end_date) : s.date;
    const k = `${s.accountId}|${date}`;
    const prev = snapSlot.get(k);
    if (prev) {
      blockRule(dec?.rule, "two snapshots would share one (account, date)");
      blockRule(prev.rule, "two snapshots would share one (account, date)");
    } else {
      snapSlot.set(k, { rule: dec?.rule });
    }
  }
}

function planPrices(
  plaidPrices: PriceRow[],
  otherPrices: PriceRow[],
  securities: Map<number, SecurityInfo>,
  boundary: DatingBoundary,
  f2Since: string,
  preOpenSessions: Set<string>,
  eraStart: string | null,
): RowDecision[] {
  const out: RowDecision[] = [];
  const otherAt = new Map<string, PriceRow>();
  for (const p of otherPrices) otherAt.set(`${p.securityId}|${p.date}`, p);
  const bySecurity = new Map<number, PriceRow[]>();
  for (const p of plaidPrices) {
    const list = bySecurity.get(p.securityId) ?? [];
    list.push(p);
    bySecurity.set(p.securityId, list);
  }

  for (const [securityId, rows] of [...bySecurity].sort((a, b) => a[0] - b[0])) {
    const sec = securities.get(securityId);
    const rule = `price:${securityId}`;
    const fund = isFundType(sec?.type ?? null);
    const isNew = (p: PriceRow) => classifyPlaidPrice(securityId, p.date, boundary) === "new";
    const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date)); // newest first
    const plaidAt = new Map(rows.map((p) => [p.date, p]));

    if (fund) {
      const decs: RowDecision[] = [];
      let blockReason: string | null = null;
      const movingAway = new Set<number>(); // ids of legacy fund rows that move or drop
      for (const p of sorted) {
        if (isNew(p)) {
          decs.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule });
          continue;
        }
        if (isMarketClosed(p.date)) {
          blockReason ??= "a legacy fund price on a closed day";
          continue;
        }
        const y = nextTradingDay(p.date);
        const authority = otherAt.get(`${securityId}|${y}`);
        if (authority) {
          if (authority.source === MANUAL_SOURCE || authority.source === null) {
            blockReason ??= "the shift target holds a manual price";
            continue;
          }
          const a = authority.close;
          const b = p.close;
          const rel = Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);
          if (!(rel <= FUND_PRICE_MATCH_TOLERANCE)) {
            blockReason ??= "a statement or TWS price on the shift target does not match the Plaid price";
            continue;
          }
          decs.push({ table: "prices", id: p.id, old: p.row, next: null, action: "PRICE_FUND_DROP_AUTHORITY", kind: "CHANGE", rule });
          movingAway.add(p.id);
          continue;
        }
        const occupant = plaidAt.get(y);
        if (occupant && !movingAway.has(occupant.id)) {
          blockReason ??= "the shift target holds a Plaid price that is not moving away";
          continue;
        }
        decs.push({ table: "prices", id: p.id, old: p.row, next: { ...p.row, date: y }, action: "PRICE_FUND_SHIFT", kind: "CHANGE", rule });
        movingAway.add(p.id);
      }
      if (blockReason) {
        for (const p of sorted) {
          if (isNew(p)) {
            out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule });
          } else {
            out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason: blockReason });
          }
        }
      } else {
        out.push(...decs);
      }
      continue;
    }

    const hasBrokerPrice =
      eraStart !== null && otherPrices.some((o) => o.securityId === securityId && o.date >= eraStart);
    for (const p of sorted) {
      if (isNew(p)) {
        out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "IMMUTABLE_NEW_FORMAT", kind: "IMMUTABLE_NEW_FORMAT", rule });
      } else if (p.date < f2Since) {
        if (hasBrokerPrice) {
          out.push({ table: "prices", id: p.id, old: p.row, next: null, action: "PRICE_NONFUND_LEGACY_DELETE", kind: "CHANGE", rule });
        } else {
          out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason: "a legacy non-fund Plaid price on a security with no other price in the Plaid era" });
        }
      } else if (isStockOrEtf(sec?.type ?? null) && preOpenSessions.has(p.date)) {
        out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "PRICE_F2_SESSION_DATED", kind: "UNCHANGED", rule });
      } else {
        out.push({ table: "prices", id: p.id, old: p.row, next: undefined, action: "BLOCK", kind: "BLOCK", rule, reason: "a non-fund Plaid price on or after f2Since that is not on a pre-open session" });
      }
    }
  }
  return out;
}

function collectPricePairs(lines: ManifestLine[]): { securityId: number; date: string }[] {
  const seen = new Set<string>();
  const out: { securityId: number; date: string }[] = [];
  const add = (securityId: number, date: string) => {
    const k = `${securityId}|${date}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ securityId, date });
  };
  for (const l of lines) {
    if (l.kind !== "CHANGE" || l.table !== "prices" || !l.old) continue;
    add(num(l.old.security_id), String(l.old.date));
    if (l.new) add(num(l.new.security_id), String(l.new.date));
  }
  return out;
}

// ── Full-book evidence and the closing ledger row (D3) ───────────────────

interface FullBookEvidence {
  ok: boolean;
  reason: string;
  priorStatementDate: string | null;
  /** Upper-cased symbols the stored parse lists for (account, date). */
  parsedSymbols: Set<string>;
}

function fullStatementBookEvidence(
  db: Database.Database,
  accountId: number,
  accountName: string,
  date: string,
  holdingRows: HoldingRow[],
): FullBookEvidence {
  const fail = (reason: string): FullBookEvidence => ({ ok: false, reason, priorStatementDate: null, parsedSymbols: new Set() });
  const stmtRows = db
    .prepare(
      `SELECT h.id, h.quantity, h.import_batch_id FROM holdings h
        WHERE h.account_id = ? AND h.as_of_date = ? AND ${statementSourcedHoldingSql()}`,
    )
    .all(accountId, date) as { id: number; quantity: number; import_batch_id: number | null }[];
  if (stmtRows.length === 0) return fail("no statement rows on the date");
  if (stmtRows.some((r) => r.import_batch_id === null)) return fail("a statement row has no import batch");
  const batchIds = [...new Set(stmtRows.map((r) => r.import_batch_id as number))];
  const parsedSymbols = new Set<string>();
  for (const batchId of batchIds) {
    const batch = db.prepare(`SELECT source_type, status FROM import_batches WHERE id = ?`).get(batchId) as
      | { source_type: string; status: string }
      | undefined;
    if (!batch) return fail("an import batch row is missing");
    if (batch.status !== "completed") return fail("an import batch is not completed");
    if (!HOLDINGS_SNAPSHOT_SOURCE_TYPES.has(batch.source_type)) return fail("an import batch is not a holdings-snapshot source");
    const raws = db.prepare(`SELECT raw_data FROM raw_imports WHERE import_batch_id = ?`).all(batchId) as { raw_data: string }[];
    if (raws.length === 0) return fail("an import batch has no stored parse");
    let listed = 0;
    for (const raw of raws) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.raw_data);
      } catch {
        return fail("a stored parse is not valid JSON");
      }
      const holdings = (parsed as { holdings?: unknown }).holdings;
      if (!Array.isArray(holdings)) return fail("a stored parse has no holdings list");
      for (const h of holdings as { accountName?: unknown; asOfDate?: unknown; symbol?: unknown }[]) {
        if (h && h.accountName === accountName && h.asOfDate === date) {
          listed++;
          if (typeof h.symbol === "string") parsedSymbols.add(h.symbol.trim().toUpperCase());
        }
      }
    }
    if (listed === 0) return fail("an import batch's parse lists no holdings for this account on the date");
  }
  // Shrink guard against the prior statement.
  const datesBefore = [
    ...new Set(
      holdingRows
        .filter((h) => h.accountId === accountId && h.date < date && h.statementGrade && !isReconKey(h.key))
        .map((h) => h.date),
    ),
  ].sort();
  const prior = datesBefore.length > 0 ? datesBefore[datesBefore.length - 1] : null;
  const count = stmtRows.filter((r) => r.quantity !== 0).length;
  if (prior !== null) {
    const priorCount = holdingRows.filter(
      (h) => h.accountId === accountId && h.date === prior && h.statementGrade && !isReconKey(h.key) && h.quantity !== 0,
    ).length;
    if (priorCount > 0 && count < priorCount * STATEMENT_SHRINK_FLOOR) {
      return { ok: false, reason: "the statement book fails the shrink guard", priorStatementDate: prior, parsedSymbols };
    }
  }
  return { ok: true, reason: "", priorStatementDate: prior, parsedSymbols };
}

/**
 * A ledger row that closes a long position in (account, security), dated
 * after `after` and on or before `onOrBefore`. Closing types, from the lot
 * engine (`computeTaxLots`, lib/compute/tax-lots.ts, through its catalogue
 * lib/queries/ledger-side-routing.ts):
 *   - SELL, SELL_TO_CLOSE, REDEMPTION: close a long;
 *   - EXPIRED, EXERCISED, ASSIGNED: close either side;
 *   - (BUY_TO_CLOSE and BUY_TO_COVER close a SHORT, so they do not count);
 *   - IBKR direction evidence can turn another loaded type into a long close.
 * The row must be one the engine actually loads (`engineLoads`). Plus
 * TRANSFER_OUT, named by the spec: the engine does not book it as a sale (an
 * in-kind gift consumes lots through its donation link), but it is ledger
 * evidence that the shares left the account.
 */
function hasClosingLedgerRow(
  db: Database.Database,
  accountId: number,
  securityId: number,
  after: string,
  onOrBefore: string,
): boolean {
  const rows = db
    .prepare(
      `SELECT t.type, t.quantity, t.price_per_share, t.amount, t.notes, COALESCE(s.security_type, '') AS security_type
         FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.account_id = ? AND t.security_id = ? AND t.trade_date > ? AND t.trade_date <= ?`,
    )
    .all(accountId, securityId, after, onOrBefore) as {
    type: string;
    quantity: number | null;
    price_per_share: number | null;
    amount: number | null;
    notes: string | null;
    security_type: string;
  }[];
  return rows.some((r) => {
    if (r.type.trim().toUpperCase() === "TRANSFER_OUT") return true;
    const route = routeLedgerRow(r);
    if (!route.engineLoads || route.certainty !== "certain") return false;
    return (route.role === "close" && route.side === "long") || route.role === "close_either";
  });
}

// ── Traced-trade census (report only) ───────────────────────────────────

function tradeCensus(
  db: Database.Database,
  accountIds: number[],
  bookList: Book[],
  holdingRows: HoldingRow[],
): PlanReport["census"] {
  if (accountIds.length === 0 || bookList.length === 0) return [];
  const eraStart = bookList[0].runDay;
  const trades = db
    .prepare(
      `SELECT t.account_id, t.trade_date, t.type, t.security_id, s.security_type
         FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.account_id IN (${accountIds.join(",")}) AND t.trade_date >= ?
        ORDER BY t.trade_date, t.id`,
    )
    .all(previousTradingDay(eraStart)) as {
    account_id: number;
    trade_date: string;
    type: string;
    security_id: number;
    security_type: string | null;
  }[];
  const plaidQty = new Map<string, number>(); // account|security|runDay
  for (const h of holdingRows) if (isPlaidKey(h.key)) plaidQty.set(`${h.accountId}|${h.securityId}|${h.date}`, h.quantity);
  const out: PlanReport["census"] = [];
  for (const tr of trades) {
    if (!TRADE_TYPES.has(tr.type.trim().toLowerCase())) continue;
    const list = bookList.filter((b) => b.accountId === tr.account_id && b.snapshot !== null);
    const q = (b: Book) => plaidQty.get(`${b.accountId}|${tr.security_id}|${b.runDay}`) ?? 0;
    const base = [...list].reverse().find((b) => b.runDay <= tr.trade_date);
    const baseQty = base ? q(base) : 0;
    const first = list.find((b) => b.runDay > tr.trade_date && Math.abs(q(b) - baseQty) > 1e-6) ?? null;
    out.push({
      accountId: tr.account_id,
      tradeDate: tr.trade_date,
      type: tr.type,
      securityId: tr.security_id,
      securityKind: tr.security_type,
      firstBookRunDay: first?.runDay ?? null,
      firstBookClass: first?.plan.class ?? null,
    });
  }
  return out;
}

// ── Binding and manifest assembly ────────────────────────────────────────

function maxId(db: Database.Database, table: string): number {
  return ((db.prepare(`SELECT MAX(id) AS m FROM ${table}`).get() as { m: number | null }).m ?? 0);
}

function scopeHash(lines: ManifestLine[]): string {
  const h = createHash("sha256");
  const parts = new Set<string>();
  for (const l of lines) {
    if (l.table && l.id !== undefined && l.hash) parts.add(`${l.table}:${l.id}:${l.hash}`);
  }
  for (const p of [...parts].sort()) h.update(`${p}\n`);
  return h.digest("hex");
}

function finishManifest(
  db: Database.Database,
  opts: PlanOptions,
  settingsRaw: { version: string | null; firstSession: string | null },
  datingState: DatingState,
  books: BookPlan[],
  lines: ManifestLine[],
  pricePairs: { securityId: number; date: string }[],
  bumpFires: boolean,
  generationAfter?: number,
): PlaidSessionDatingManifest {
  const byKind: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const l of lines) {
    byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
    byAction[l.action] = (byAction[l.action] ?? 0) + 1;
  }
  const blocking = lines.filter((l) => l.kind === "BLOCK" || l.kind === "UNCLASSIFIED").length;
  const migrationCount = (db.prepare(`SELECT COUNT(*) AS c FROM schema_migrations`).get() as { c: number }).c;
  const generation = getTaxInputGeneration(db);
  return {
    format: "plaid-session-dating-manifest/1",
    binding: {
      dbPath: opts.dbPath,
      migrationCount,
      datingVersion: settingsRaw.version,
      datingFirstSession: settingsRaw.firstSession,
      maxHoldingsId: maxId(db, "holdings"),
      maxPricesId: maxId(db, "prices"),
      maxSnapshotsId: maxId(db, "monthly_snapshots"),
      taxInputGeneration: generation,
      configSha256: opts.configSha256,
      scopeSha256: scopeHash(lines),
    },
    config: opts.config,
    datingState,
    books,
    lines,
    predicted: {
      pricePairs,
      bumpFires,
      taxInputGenerationAfter: generationAfter ?? generation,
    },
    counts: { byKind, byAction, blocking },
  };
}

/** Canonical form of a manifest for comparison (the write time is ignored). */
export function manifestComparable(m: PlaidSessionDatingManifest): string {
  const { generatedAt: _ignored, ...rest } = m;
  void _ignored;
  return canonicalJson(rest);
}

// ── Apply (inside the caller's transaction) ──────────────────────────────

const TABLE_DATE_COLUMN: Record<ScopeTable, string> = {
  holdings: "as_of_date",
  monthly_snapshots: "month_end_date",
  prices: "date",
};

function tableColumns(db: Database.Database, table: ScopeTable): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

function readRow(db: Database.Database, table: ScopeTable, id: number): DbRow | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as DbRow | undefined;
}

/**
 * Applies the CHANGE lines of a manifest. Must run inside the caller's
 * transaction. Steps: every changed row must still equal its manifest old
 * row; the price pairs go through `bumpIfPricesAffectSyntheticCloses` (before
 * any price changes, the helper's contract); deletes; then updates in two
 * phases (a unique placeholder first) so the unique slots never collide
 * mid-way; finally every changed row must equal its manifest new row.
 * Throws on any difference. Returns whether the tax generation was bumped.
 */
export function applyManifestChanges(db: Database.Database, manifest: PlaidSessionDatingManifest): { bumped: boolean } {
  const changes = manifest.lines.filter((l) => l.kind === "CHANGE");
  for (const l of changes) {
    if (!l.table || l.id === undefined || !l.old) throw new Error("a CHANGE line lacks its table, id or old row");
    const cur = readRow(db, l.table, l.id);
    if (!cur || rowHash(cur) !== rowHash(l.old)) {
      throw new Error(`${l.table} row ${l.id} differs from the manifest's old row`);
    }
  }
  const genBefore = getTaxInputGeneration(db);
  bumpIfPricesAffectSyntheticCloses(db, manifest.predicted.pricePairs);
  const bumped = getTaxInputGeneration(db) !== genBefore;

  for (const l of changes) {
    if (l.new !== null) continue;
    const r = db.prepare(`DELETE FROM ${l.table} WHERE id = ?`).run(l.id);
    if (r.changes !== 1) throw new Error(`${l.table} row ${l.id} was not deleted`);
  }
  const updates = changes.filter((l) => l.new);
  const columns = new Map<ScopeTable, Set<string>>();
  for (const l of updates) {
    const table = l.table as ScopeTable;
    const dateCol = TABLE_DATE_COLUMN[table];
    const keySet = table === "holdings" ? `, source_key = '~plaid-dating-tmp:' || id` : "";
    db.prepare(`UPDATE ${table} SET ${dateCol} = '~' || id${keySet} WHERE id = ?`).run(l.id);
  }
  for (const l of updates) {
    const table = l.table as ScopeTable;
    let cols = columns.get(table);
    if (!cols) {
      cols = tableColumns(db, table);
      columns.set(table, cols);
    }
    const next = l.new as DbRow;
    const names = Object.keys(next).filter((k) => k !== "id");
    for (const n of names) if (!cols.has(n)) throw new Error(`manifest names an unknown column ${table}.${n}`);
    const sql = `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE id = ?`;
    const r = db.prepare(sql).run(...names.map((n) => next[n]), l.id);
    if (r.changes !== 1) throw new Error(`${table} row ${l.id} was not updated`);
  }
  for (const l of updates) {
    const cur = readRow(db, l.table as ScopeTable, l.id as number);
    if (!cur || rowHash(cur) !== rowHash(l.new as DbRow)) {
      throw new Error(`${l.table} row ${l.id} does not equal the manifest's new row after the apply`);
    }
  }
  return { bumped };
}

/** Per-table digest of every row whose id is not in `skip`. */
function tableDigest(db: Database.Database, table: string, skip: Set<number>, where = ""): string {
  const h = createHash("sha256");
  const hasId = tableColumns(db, table as ScopeTable).has("id");
  const rows = db.prepare(`SELECT * FROM ${table} ${where} ${hasId ? "ORDER BY id" : ""}`).all() as DbRow[];
  const lines = rows
    .filter((r) => !hasId || !skip.has(num(r.id)))
    .map((r) => canonicalJson(r));
  if (!hasId) lines.sort();
  for (const l of lines) h.update(`${l}\n`);
  return h.digest("hex");
}

/** Settings rows the apply may change; every other settings row must stay identical. */
const SETTINGS_EXEMPT = ["tax_input_generation", "plaid_dating_version", "plaid_dating_first_session"];

export interface ApplySnapshot {
  digests: Record<string, string>;
  statementGradeCounts: Map<string, number>;
  tombstoneGrade: Map<number, boolean>;
}

function touchedAccountDates(manifest: PlaidSessionDatingManifest): { accountId: number; date: string }[] {
  const out = new Map<string, { accountId: number; date: string }>();
  for (const l of manifest.lines) {
    if (l.kind !== "CHANGE" || l.table !== "holdings") continue;
    for (const r of [l.old, l.new]) {
      if (!r) continue;
      const a = num(r.account_id);
      const d = String(r.as_of_date);
      out.set(`${a}|${d}`, { accountId: a, date: d });
    }
  }
  return [...out.values()];
}

/** Captures what the proof compares (call before `applyManifestChanges`). */
export function captureApplySnapshot(db: Database.Database, manifest: PlaidSessionDatingManifest): ApplySnapshot {
  const changed = new Map<string, Set<number>>();
  for (const l of manifest.lines) {
    if (l.kind !== "CHANGE" || !l.table || l.id === undefined) continue;
    const s = changed.get(l.table) ?? new Set<number>();
    s.add(l.id);
    changed.set(l.table, s);
  }
  const digests: Record<string, string> = {};
  for (const t of ["holdings", "prices", "monthly_snapshots"] as const) digests[t] = tableDigest(db, t, changed.get(t) ?? new Set());
  for (const t of ["transactions", "corporate_actions", "import_batches"]) {
    if (tableExists(db, t)) digests[t] = tableDigest(db, t, new Set());
  }
  digests.settings = tableDigest(db, "settings", new Set(), `WHERE key NOT IN (${SETTINGS_EXEMPT.map((k) => `'${k}'`).join(",")})`);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM holdings h WHERE h.account_id = ? AND h.as_of_date = ? AND ${statementGradeHoldingSql("h")}`,
  );
  const statementGradeCounts = new Map<string, number>();
  for (const { accountId, date } of touchedAccountDates(manifest)) {
    statementGradeCounts.set(`${accountId}|${date}`, (count.get(accountId, date) as { c: number }).c);
  }
  const tombstoneGrade = new Map<number, boolean>();
  for (const r of db
    .prepare(`SELECT h.id, ${statementGradeHoldingSql("h")} AS sg FROM holdings h WHERE h.source_key LIKE '${RECON_HOLDING_SOURCE_PREFIX}%'`)
    .all() as { id: number; sg: number }[]) {
    tombstoneGrade.set(r.id, r.sg === 1);
  }
  return { digests, statementGradeCounts, tombstoneGrade };
}

/**
 * The D6 step-4 proof, after `applyManifestChanges`: every UNCHANGED and
 * IMMUTABLE_NEW_FORMAT row hash-identical; every row outside the change set
 * identical per table (holdings, prices, monthly_snapshots, transactions,
 * corporate_actions, import_batches, settings minus the exempt keys); the
 * D4 check (statement-grade count per touched account and date, and each
 * surviving tombstone's statement-grade class, unchanged); no foreign-key
 * violation. Throws on the first failure.
 */
export function proveApplied(db: Database.Database, manifest: PlaidSessionDatingManifest, before: ApplySnapshot): void {
  for (const l of manifest.lines) {
    if ((l.kind === "UNCHANGED" || l.kind === "IMMUTABLE_NEW_FORMAT") && l.table && l.id !== undefined) {
      const cur = readRow(db, l.table, l.id);
      if (!cur || rowHash(cur) !== l.hash) throw new Error(`${l.kind} ${l.table} row ${l.id} changed`);
    }
  }
  const after = captureApplySnapshot(db, manifest);
  for (const [t, d] of Object.entries(before.digests)) {
    if (after.digests[t] !== d) throw new Error(`rows outside the change set differ in ${t}`);
  }
  for (const [k, c] of before.statementGradeCounts) {
    if (after.statementGradeCounts.get(k) !== c) throw new Error(`statement-grade rows changed on ${k}`);
  }
  for (const [id, grade] of before.tombstoneGrade) {
    const g = after.tombstoneGrade.get(id);
    if (g !== undefined && g !== grade) throw new Error(`tombstone ${id} changed its statement-grade class`);
  }
  for (const [id, grade] of after.tombstoneGrade) {
    if (grade && !before.tombstoneGrade.get(id)) throw new Error(`a statement-grade tombstone ${id} appeared`);
  }
  const fk = db.prepare(`PRAGMA foreign_key_check`).all();
  if (fk.length > 0) throw new Error(`foreign_key_check reports ${fk.length} violation(s)`);
}

/**
 * Runs the apply and the proof on an in-memory copy (the database is
 * serialized, never touched). Returns the predicted generation and whether
 * the bump fires, or the error the apply would hit.
 */
function simulateApply(
  db: Database.Database,
  manifest: PlaidSessionDatingManifest,
): { error: string | null; bumpFires: boolean; generationAfter: number } {
  const image = db.serialize();
  // Header bytes 18 and 19 are the file-format write and read versions: 2
  // means WAL, which an in-memory copy cannot open. 1 is the rollback
  // journal; the copy is private and thrown away.
  image[18] = 1;
  image[19] = 1;
  const copy = new Database(image);
  try {
    copy.pragma("foreign_keys = ON");
    let bumpFires = false;
    let error: string | null = null;
    try {
      copy.transaction(() => {
        const before = captureApplySnapshot(copy, manifest);
        bumpFires = applyManifestChanges(copy, manifest).bumped;
        proveApplied(copy, manifest, before);
      })();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return { error, bumpFires, generationAfter: getTaxInputGeneration(copy) };
  } finally {
    copy.close();
  }
}

// ── --remint-closures (OPEN-7) ───────────────────────────────────────────

/** Actions whose zero row --remint-closures may restore. */
export const REMINT_ACTIONS: readonly ActionCode[] = [
  "SURVIVOR_TO_ZERO",
  "ZERO_SURVIVOR_RELABEL",
  "TOMBSTONE_MOVE",
  "TOMBSTONE_KEEP_ON_STATEMENT_DATE",
];

export interface RemintPlan {
  present: number;
  missing: DbRow[];
  conflicts: { accountId: number; securityId: number; date: string; reason: string }[];
}

/**
 * For every zero row of the manifest (SURVIVOR_TO_ZERO, ZERO_SURVIVOR_RELABEL,
 * moved and kept tombstones), keyed by (account, security, date), not by row
 * id: present when a zero row sits on that slot; missing when the slot is
 * empty and the manifest's source key is free; a conflict otherwise.
 */
export function planRemintClosures(db: Database.Database, manifest: PlaidSessionDatingManifest): RemintPlan {
  const slot = db.prepare(`SELECT id, quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`);
  const keyUsed = db.prepare(`SELECT id FROM holdings WHERE source_key = ?`);
  const plan: RemintPlan = { present: 0, missing: [], conflicts: [] };
  for (const l of manifest.lines) {
    if (l.kind !== "CHANGE" || l.table !== "holdings" || !l.new || !REMINT_ACTIONS.includes(l.action)) continue;
    const r = l.new;
    const a = num(r.account_id);
    const s = num(r.security_id);
    const d = String(r.as_of_date);
    if (num(r.quantity) !== 0) {
      plan.conflicts.push({ accountId: a, securityId: s, date: d, reason: "the manifest row is not a zero" });
      continue;
    }
    const cur = slot.get(a, s, d) as { id: number; quantity: number } | undefined;
    if (cur) {
      if (cur.quantity === 0) plan.present++;
      else plan.conflicts.push({ accountId: a, securityId: s, date: d, reason: "the slot holds a non-zero row" });
      continue;
    }
    if (keyUsed.get(r.source_key)) {
      plan.conflicts.push({ accountId: a, securityId: s, date: d, reason: "the source key is used by another row" });
      continue;
    }
    plan.missing.push({
      account_id: a,
      security_id: s,
      quantity: 0,
      cost_basis: r.cost_basis ?? 0,
      as_of_date: d,
      source_key: r.source_key,
      import_batch_id: null,
    });
  }
  return plan;
}

/** Inserts the missing zero rows. Runs inside the caller's transaction. */
export function applyRemintClosures(db: Database.Database, plan: RemintPlan): number {
  if (plan.conflicts.length > 0) throw new Error(`refusing: ${plan.conflicts.length} conflict(s) in the re-mint plan`);
  const ins = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  for (const r of plan.missing) {
    n += ins.run(r.account_id, r.security_id, r.quantity, r.cost_basis, r.as_of_date, r.source_key, r.import_batch_id).changes;
  }
  return n;
}
