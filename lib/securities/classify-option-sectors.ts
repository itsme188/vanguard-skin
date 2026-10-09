import type Database from "better-sqlite3";
import { generateTextForFeature, AIRefusalError } from "@/lib/ai/generate";
import { normalizeSector, GICS_SECTORS } from "@/lib/securities/normalize-sector";
import { parseJsonArrayLenient } from "@/lib/ai/extract-json";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { todayET } from "@/lib/calendar/date-utils";
import {
  resolveUnderlyingSector,
  OPTION_SECTOR_SOURCE_INHERITED,
  OPTION_SECTOR_SOURCE_AI,
  type UnderlyingSector,
} from "@/lib/securities/underlying-sector";

// The underlying lookup lives in an AI-free module; these names stay
// importable from here for the callers that already use them.
export { resolveUnderlyingSector, type UnderlyingSector };

export interface OptionSectorResult {
  /** Option rows written this run (inherited + resynced + AI). */
  classified: number;
  /** Of `classified`, blank rows that took their underlying's stored sector (no AI). */
  inherited: number;
  /** Of `classified`, rows whose stored DERIVED sector no longer matched their
   *  underlying's and were brought back in line (no AI). */
  resynced: number;
  errors: string[];
}

/**
 * `securities.sector_source` values this module stamps on an OPTION row
 * (migration 071's provenance column).
 *  - `underlying_inherited` (new 2026-10-07): the sector was copied from the
 *    underlying's stored sector.
 *  - `ai_classify` (the existing value for an AI-assigned sector): the
 *    underlying was unknown or had no sector, so the AI was asked.
 * Both mean "derived, safe to re-derive": a row carrying one of them (and no
 * `sector_verified_at` stamp) is a MAINTAINED value that follows its
 * underlying on every run. Any other source on an option row (`csv_import`,
 * `gics_verified`, `tws_bloomberg`, an unrecognized value) was put there by an
 * import, the verification sweep or the broker and is never overwritten here.
 * An unstamped (NULL source) non-blank sector is never overwritten here
 * either: its origin is unknown, so it is scripts/repair-option-sectors.ts's
 * business, where the owner sees a dry run first.
 */
export { OPTION_SECTOR_SOURCE_INHERITED, OPTION_SECTOR_SOURCE_AI };

/** SQL: option row `alias` carries a derived sector this module maintains. */
function maintainedOptionSectorSql(alias: string): string {
  const p = alias === "" ? "" : `${alias}.`;
  return `${p}sector_source IN ('${OPTION_SECTOR_SOURCE_INHERITED}', '${OPTION_SECTOR_SOURCE_AI}')
         AND ${p}sector_verified_at IS NULL
         AND ${p}sector IS NOT NULL AND TRIM(${p}sector) != ''`;
}

/**
 * Remembered AI misses. An underlying that has no usable stored sector is put
 * to the AI; when the AI ANSWERS and still gives no canonical sector for it,
 * the option stays blank and, before this memory, the same question was paid
 * for again on every sync. The miss is kept in the `settings` key-value table
 * as a JSON object { "<UNDERLYING>": "<YYYY-MM-DD it was asked, ET>" }.
 *
 * What a remembered miss suppresses: ONLY the AI question, and only for
 * `OPTION_SECTOR_AI_MISS_RETRY_DAYS` days. It never suppresses inheritance:
 * the moment the underlying has a usable stored sector the option takes it
 * (no AI call) and the entry is dropped. A failed call (network, account,
 * refusal, unparseable reply) is not a miss and is not remembered: nothing
 * was learned about the ticker.
 */
export const OPTION_SECTOR_AI_MISSES_KEY = "option_sector_ai_misses";
export const OPTION_SECTOR_AI_MISS_RETRY_DAYS = 30;

const MISS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readAiMisses(db: Database.Database): Map<string, string> {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(OPTION_SECTOR_AI_MISSES_KEY) as
    | { value: string }
    | undefined;
  const out = new Map<string, string>();
  if (!row) return out;
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && MISS_DATE_RE.test(v)) out.set(k.trim().toUpperCase(), v);
    }
  } catch {
    // An unreadable value is treated as no memory: the cost is one repeated question.
  }
  return out;
}

function writeAiMisses(db: Database.Database, misses: Map<string, string>): void {
  if (misses.size === 0) {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(OPTION_SECTOR_AI_MISSES_KEY);
    return;
  }
  const value = JSON.stringify(Object.fromEntries([...misses.entries()].sort(([a], [b]) => a.localeCompare(b))));
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(OPTION_SECTOR_AI_MISSES_KEY, value);
}

/**
 * When option sectors were last CHECKED: found in line with their underlyings,
 * or brought in line. Kept in the `settings` key-value table as a UTC time in
 * SQLite's own `YYYY-MM-DD HH:MM:SS` form. The Analysis trust strip shows it.
 *
 * Two writers, both in this file:
 *  - `classifyOptionSectors`, at its end, on any run that finished with no
 *    error (a run with nothing to do counts: that is a clean check);
 *  - `markOptionSectorsChecked`, which the two callers use on the branch
 *    where their free pre-check found no work and they skip the run.
 * A run that hit an AI error does NOT move it: the check did not finish.
 * Never written by an import or under lib/import/.
 */
export const SECTOR_CLASSIFY_LAST_RUN_KEY = "sector_classify_last_run_at";

/**
 * Record that option sectors were just checked and nothing needed doing.
 * For a caller that ran `getUnsectoredOptionUnderlyings`, got an empty list
 * and therefore skips `classifyOptionSectors`. Writes the time only: no
 * sector, no other setting.
 */
export function markOptionSectorsChecked(db: Database.Database): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, datetime('now'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(SECTOR_CLASSIFY_LAST_RUN_KEY);
}

/**
 * The stored last-run time, read back through `datetime()` so a `T`/`Z`
 * spelling comes out in the same space-separated UTC form as every other
 * stored stamp, and a value that is not a time reads as null (never shown).
 */
export function getLastSectorClassifyRun(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT datetime(value) AS at FROM settings WHERE key = ?`)
    .get(SECTOR_CLASSIFY_LAST_RUN_KEY) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD), by calendar date. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The miss recorded on `askedOn` still suppresses the AI question on `today`. */
function missStillFresh(askedOn: string, today: string): boolean {
  const age = daysBetween(askedOn, today);
  // A date in the future (clock change, hand edit) is not trusted.
  return Number.isFinite(age) && age >= 0 && age < OPTION_SECTOR_AI_MISS_RETRY_DAYS;
}

/**
 * The pre-check both callers use to decide whether `classifyOptionSectors` has
 * work: distinct underlying tickers (upper-case, trimmed) of HELD options that
 *   1. still have a blank sector, or
 *   2. carry a maintained derived sector that no longer equals their
 *      underlying's stored sector (the underlying was sectored after the
 *      option, or its sector changed).
 * Blank-sector underlyings come first. The name is historical.
 *
 * Left out: a blank-sector underlying with no usable stored sector whose AI
 * question is a remembered miss (see `OPTION_SECTOR_AI_MISSES_KEY`). There is
 * nothing to do for it until the underlying gets a sector or the miss ages out.
 */
export function getUnsectoredOptionUnderlyings(db: Database.Database, today: string = todayET()): string[] {
  return optionSectorWork(db, today)
    .filter((w) => !w.rememberedMiss)
    .map((w) => w.underlying);
}

interface OptionSectorWork {
  underlying: string;
  /** A held option on it has a blank sector. */
  blank: boolean;
  /** The underlying's usable stored sector, or null (unknown / no sector). */
  resolved: UnderlyingSector | null;
  /** Unresolved, and the AI was asked recently and gave no usable sector. */
  rememberedMiss: boolean;
}

function optionSectorWork(db: Database.Database, today: string): OptionSectorWork[] {
  const held = `FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE ${latestHoldingsPredicate({})}
         AND LOWER(s.security_type) = 'option'
         AND s.underlying_symbol IS NOT NULL AND TRIM(s.underlying_symbol) != ''`;
  const blanks = db
    .prepare(
      `SELECT DISTINCT UPPER(TRIM(s.underlying_symbol)) AS u ${held}
         AND (s.sector IS NULL OR TRIM(s.sector) = '')`
    )
    .all() as Array<{ u: string }>;
  const maintained = db
    .prepare(
      `SELECT DISTINCT UPPER(TRIM(s.underlying_symbol)) AS u, s.sector AS sector ${held}
         AND ${maintainedOptionSectorSql("s")}`
    )
    .all() as Array<{ u: string; sector: string }>;

  const misses = blanks.length > 0 ? readAiMisses(db) : new Map<string, string>();
  const work = new Map<string, OptionSectorWork>();
  for (const { u } of blanks) {
    const resolved = resolveUnderlyingSector(db, u);
    const askedOn = misses.get(u);
    work.set(u, {
      underlying: u,
      blank: true,
      resolved,
      // A resolved underlying is never held back: inheriting costs nothing.
      rememberedMiss: resolved === null && askedOn !== undefined && missStillFresh(askedOn, today),
    });
  }
  const cache = new Map<string, UnderlyingSector | null>();
  for (const { u, sector } of maintained) {
    if (work.has(u)) continue;
    if (!cache.has(u)) cache.set(u, resolveUnderlyingSector(db, u));
    const resolved = cache.get(u) ?? null;
    // An underlying that is unknown or has lost its sector proves nothing
    // about the stored value: the option keeps it.
    if (resolved && resolved.sector !== sector) {
      work.set(u, { underlying: u, blank: false, resolved, rememberedMiss: false });
    }
  }
  return [...work.values()];
}

const SYSTEM = `You assign a GICS sector to each ticker (a stock or a sector/thematic ETF).
Return ONLY a JSON array, one object per input ticker:
{"symbol":"TICKER","sector":"<exactly one of: Energy, Materials, Industrials, Consumer Discretionary, Consumer Staples, Healthcare, Financials, Technology, Communication Services, Utilities, Real Estate>"}
For sector/thematic ETFs use the dominant GICS sector (SMH/IGV/SOXX/HACK->Technology, KRE/XLF->Financials, XLE->Energy, XLU/VPU->Utilities, ARKK->Technology). No prose, no code fences.`;

/**
 * Give every held blank-sector option a sector, written onto the option row
 * (the sector breakdown, its drill-down, the factor tilts and cash-deploy all
 * read an option's OWN stored sector; none of them inherits at read time).
 *
 * Owner ruling 2026-10-06: an option takes its UNDERLYING's stored sector when
 * the underlying is a known security with one, so an index-fund option lands
 * in the fund's own bucket (e.g. "Diversified") instead of whatever single
 * GICS sector the AI picks for the fund. The AI is asked only for an
 * underlying that is unknown or has no usable sector; for those only a
 * canonical GICS-11 value is written and junk is dropped.
 *
 * The stored value is a MAINTAINED derived value: a sector this module wrote
 * earlier (stamped `underlying_inherited` or `ai_classify`, no verification
 * stamp) is rewritten, with no AI call, when the underlying's usable stored
 * sector differs from it. That covers a new option that reached the AI before
 * its underlying had a row or a sector, and an underlying that is later
 * reclassified. An underlying that is unknown or has lost its sector never
 * blanks or changes the option.
 *
 * Never overwritten: a non-blank sector stamped by an import, the verification
 * sweep or the broker, one with an unrecognized or missing source, or any row
 * with a `sector_verified_at` stamp. Unstamped rows stored wrong before this
 * ruling are the business of scripts/repair-option-sectors.ts.
 *
 * Held vs not held (one rule for all three writes): the WORK LIST is driven by
 * held options only (`getUnsectoredOptionUnderlyings`); for an underlying on
 * that list, every option row naming it is written, held or not. An underlying
 * with no held option that needs work is not visited.
 *
 * An underlying the AI was asked about and gave no canonical sector for is a
 * remembered miss (`OPTION_SECTOR_AI_MISSES_KEY`): it is not asked again for
 * `OPTION_SECTOR_AI_MISS_RETRY_DAYS` days, and it still inherits, with no AI
 * call, as soon as the underlying has a usable stored sector.
 *
 * A run that finished without an error, with or without work, leaves its
 * time in `settings` (`SECTOR_CLASSIFY_LAST_RUN_KEY`).
 *
 * Idempotent: a second run finds no work.
 */
export async function classifyOptionSectors(
  db: Database.Database,
  today: string = todayET()
): Promise<OptionSectorResult> {
  const work = optionSectorWork(db, today);
  if (work.length === 0) {
    // Nothing to do is a clean check.
    markOptionSectorsChecked(db);
    return { classified: 0, inherited: 0, resynced: 0, errors: [] };
  }

  const writeSector = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = ?
     WHERE LOWER(security_type) = 'option' AND UPPER(TRIM(underlying_symbol)) = ?
       AND (sector IS NULL OR TRIM(sector) = '')`
  );
  const resyncSector = db.prepare(
    `UPDATE securities SET sector = ?, sector_source = '${OPTION_SECTOR_SOURCE_INHERITED}'
     WHERE LOWER(security_type) = 'option' AND UPPER(TRIM(underlying_symbol)) = ?
       AND ${maintainedOptionSectorSql("")}
       AND sector != ?`
  );

  // Known underlyings first: no AI call, and nothing the AI does later can
  // undo it (the AI write only fills blanks).
  let inherited = 0;
  let resynced = 0;
  const needAi: string[] = [];
  // Underlyings still waiting on the AI (asked now or held back). Any
  // remembered miss outside this set is finished business and is dropped.
  const unresolved = new Set<string>();
  for (const { underlying, resolved, rememberedMiss } of work) {
    if (!resolved) {
      // Only a blank-sector option puts an unresolved underlying on the list.
      unresolved.add(underlying);
      if (!rememberedMiss) needAi.push(underlying);
      continue;
    }
    resynced += resyncSector.run(resolved.sector, underlying, resolved.sector).changes;
    inherited += writeSector.run(resolved.sector, OPTION_SECTOR_SOURCE_INHERITED, underlying).changes;
  }

  let classified = inherited + resynced;
  const errors: string[] = [];
  const newMisses: string[] = [];
  const BATCH = 30;
  for (let i = 0; i < needAi.length; i += BATCH) {
    const batch = needAi.slice(i, i + BATCH);
    const asked = new Set(batch);
    const prompt = `Tickers:\n${batch.map((t) => `- ${t}`).join("\n")}`;
    try {
      // No `temperature` — tier-resolved models can reject it as deprecated (QA 2026-07-07).
      const { text } = await generateTextForFeature("securityClassification", { maxOutputTokens: 2000, system: SYSTEM, prompt });
      // Lenient parse: tolerates a prose preamble, a single bare object (common
      // for a one-ticker batch), a {results:[...]} wrapper, and raw C0 control
      // characters inside string literals. A reply that is none of those throws
      // a plain-English error instead of "results is not iterable".
      const results = parseJsonArrayLenient(text, "sector classifications");
      const answered = new Set<string>();
      for (const raw of results) {
        if (typeof raw !== "object" || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const gics = normalizeSector(typeof r.sector === "string" ? r.sector : null);
        // Strict: only write a canonical GICS-11 sector. normalizeSector also
        // passes through non-GICS labels ("Diversified"/"Fixed Income"); those
        // reach an option only by inheritance from a stored underlying sector,
        // never from an AI answer.
        if (!gics || !r.symbol || !GICS_SECTORS.includes(gics as (typeof GICS_SECTORS)[number])) continue;
        // Only a ticker this batch asked about: an answer for anything else
        // could land on an option whose underlying was never sent.
        const symbol = String(r.symbol).trim().toUpperCase();
        if (!asked.has(symbol)) continue;
        classified += writeSector.run(gics, OPTION_SECTOR_SOURCE_AI, symbol).changes;
        answered.add(symbol);
        // Sectored now: no longer waiting on anything.
        unresolved.delete(symbol);
      }
      // The AI replied and these tickers still have no canonical sector.
      for (const t of batch) if (!answered.has(t)) newMisses.push(t);
    } catch (err) {
      if (err instanceof AIRefusalError) {
        errors.push(`Batch ${i / BATCH + 1}: AI refusal`);
        continue;
      }
      errors.push(`Batch ${i / BATCH + 1}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  // Keep the memory in step: record this run's misses, drop every entry whose
  // underlying is no longer waiting on the AI. Written only when it changes.
  const before = readAiMisses(db);
  const after = new Map<string, string>();
  for (const [u, askedOn] of before) if (unresolved.has(u)) after.set(u, askedOn);
  for (const u of newMisses) after.set(u, today);
  const changed = after.size !== before.size || [...after].some(([u, d]) => before.get(u) !== d);
  if (changed) writeAiMisses(db, after);

  // Leave the time behind (see SECTOR_CLASSIFY_LAST_RUN_KEY): every option was
  // checked and is in line, was brought in line, or is waiting on an
  // underlying with no sector (Data Health lists those). An AI error means the
  // check did not finish, so the time stays where it was.
  if (errors.length === 0) markOptionSectorsChecked(db);

  return { classified, inherited, resynced, errors };
}
