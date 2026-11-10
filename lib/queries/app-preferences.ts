/**
 * Readers for the owner-editable preferences kept in the SQLite `settings`
 * key-value table (Settings page). Read-only: nothing here writes, seeds or
 * normalises a row. The writers live in `lib/mutations/app-preferences.ts`.
 *
 * Each reader mirrors the module that really consumes the key:
 *  - worksheet printer: `lib/earnings/worksheet.ts`
 *  - pdftotext path:    `lib/print-watch/pdf.ts` (PDFTOTEXT_SETTING_KEY)
 *  - ignored symbols:   `lib/calendar/coverage-guard.ts`
 *  - construction caps: `getCaps` in `lib/compute/exposure-delta.ts` and the
 *    inline read in `lib/compute/cash-deploy.ts` (snake_case, 2-tuple beta_range)
 */
import type Database from "better-sqlite3";

export const WORKSHEET_PRINTER_KEY = "worksheet_printer_name";
export const PDFTOTEXT_PATH_KEY = "pdftotext_path";
export const COVERAGE_IGNORED_KEY = "coverage_guard_ignored_symbols";
export const CONSTRUCTION_CAPS_KEY_PREFIX = "construction_caps_";

export const CAP_SCOPES = ["all", "vanguard", "roth", "ibkr"] as const;
export type CapScope = (typeof CAP_SCOPES)[number];

export function constructionCapsKey(scope: CapScope): string {
  return `${CONSTRUCTION_CAPS_KEY_PREFIX}${scope}`;
}

export interface Caps {
  top1Max: number;
  top3Max: number;
  sectorMax: number;
  betaMin: number;
  betaMax: number;
}

/** Same fallbacks as DEFAULT_CAPS in lib/compute/exposure-delta.ts. */
export const DEFAULT_CAPS_VIEW: Caps = {
  top1Max: 0.1,
  top3Max: 0.25,
  sectorMax: 0.35,
  betaMin: 0.7,
  betaMax: 1.2,
};

export interface AppPreferences {
  worksheetPrinterName: string;
  pdftotextPath: string;
  coverageGuardIgnoredSymbols: string[];
  constructionCaps: Record<CapScope, Caps>;
}

function readValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function readCaps(db: Database.Database, scope: CapScope): Caps {
  const raw = readValue(db, constructionCapsKey(scope));
  if (raw === undefined) return { ...DEFAULT_CAPS_VIEW };
  try {
    const p = JSON.parse(raw) as {
      top1_max?: unknown;
      top3_max?: unknown;
      sector_max?: unknown;
      beta_range?: unknown;
    };
    const range = Array.isArray(p.beta_range) ? p.beta_range : [];
    return {
      top1Max: finite(p.top1_max) ? p.top1_max : DEFAULT_CAPS_VIEW.top1Max,
      top3Max: finite(p.top3_max) ? p.top3_max : DEFAULT_CAPS_VIEW.top3Max,
      sectorMax: finite(p.sector_max) ? p.sector_max : DEFAULT_CAPS_VIEW.sectorMax,
      betaMin: finite(range[0]) ? range[0] : DEFAULT_CAPS_VIEW.betaMin,
      betaMax: finite(range[1]) ? range[1] : DEFAULT_CAPS_VIEW.betaMax,
    };
  } catch {
    return { ...DEFAULT_CAPS_VIEW };
  }
}

export function readIgnoredSymbols(db: Database.Database): string[] {
  const raw = readValue(db, COVERAGE_IGNORED_KEY);
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((s) => String(s).toUpperCase()) : [];
  } catch {
    return [];
  }
}

/** Read-only. Never writes, seeds or normalises. */
export function getAppPreferences(db: Database.Database): AppPreferences {
  const constructionCaps = {} as Record<CapScope, Caps>;
  for (const scope of CAP_SCOPES) constructionCaps[scope] = readCaps(db, scope);
  return {
    worksheetPrinterName: (readValue(db, WORKSHEET_PRINTER_KEY) ?? "").trim(),
    pdftotextPath: (readValue(db, PDFTOTEXT_PATH_KEY) ?? "").trim(),
    coverageGuardIgnoredSymbols: readIgnoredSymbols(db),
    constructionCaps,
  };
}
