/**
 * Validated writers for the Settings-page preferences (SQLite `settings`
 * table). `applyPreferencesPatch` validates everything first, then writes all
 * rows in ONE transaction; a refusal writes nothing.
 */
import type Database from "better-sqlite3";
import {
  CAP_SCOPES,
  COVERAGE_IGNORED_KEY,
  PDFTOTEXT_PATH_KEY,
  WORKSHEET_PRINTER_KEY,
  constructionCapsKey,
  getAppPreferences,
  type AppPreferences,
  type CapScope,
  type Caps,
} from "@/lib/queries/app-preferences";
import { TICKER_RE, invalidTickerMessage, normalizeTicker } from "@/lib/settings-ticker-rule";

export type PatchResult =
  | { ok: true; data: AppPreferences }
  | { ok: false; error: string };

type Write = { key: string; value: string | null }; // null = delete


function inRange01(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1;
}

function validateCaps(scope: string, raw: unknown): { error: string } | { caps: Caps } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `The ${scope} caps must be an object.` };
  }
  const c = raw as Record<string, unknown>;
  const fields: Array<[keyof Caps, string]> = [
    ["top1Max", "Largest position"],
    ["top3Max", "Top three positions"],
    ["sectorMax", "Sector"],
  ];
  for (const [k, label] of fields) {
    if (!inRange01(c[k])) {
      return { error: `${label} cap for ${scope} must be a number above 0 and at most 1 (for example 0.10 for 10%).` };
    }
  }
  const { top1Max, top3Max, sectorMax, betaMin, betaMax } = c as Record<string, number>;
  if (top1Max > top3Max) {
    return { error: `For ${scope}, the largest-position cap cannot exceed the top-three cap.` };
  }
  if (
    typeof betaMin !== "number" || typeof betaMax !== "number" ||
    !Number.isFinite(betaMin) || !Number.isFinite(betaMax) ||
    betaMin < 0 || betaMax > 5 || !(betaMin < betaMax)
  ) {
    return { error: `Beta range for ${scope} must satisfy 0 <= low < high <= 5.` };
  }
  return { caps: { top1Max, top3Max, sectorMax, betaMin, betaMax } };
}

export function applyPreferencesPatch(db: Database.Database, body: unknown): PatchResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;
  const writes: Write[] = [];

  for (const [field, key, label] of [
    ["worksheetPrinterName", WORKSHEET_PRINTER_KEY, "Printer name"],
    ["pdftotextPath", PDFTOTEXT_PATH_KEY, "pdftotext path"],
  ] as const) {
    if (!(field in b)) continue;
    const v = b[field];
    if (typeof v !== "string") return { ok: false, error: `${label} must be text.` };
    const t = v.trim();
    writes.push({ key, value: t === "" ? null : t });
  }

  if ("coverageGuardIgnoredSymbols" in b) {
    const v = b.coverageGuardIgnoredSymbols;
    if (!Array.isArray(v)) return { ok: false, error: "Ignored symbols must be a list." };
    const out: string[] = [];
    for (const item of v) {
      if (typeof item !== "string") return { ok: false, error: "Each ignored symbol must be text." };
      const s = normalizeTicker(item);
      if (!TICKER_RE.test(s)) {
        return { ok: false, error: invalidTickerMessage(item) };
      }
      if (!out.includes(s)) out.push(s);
    }
    writes.push({ key: COVERAGE_IGNORED_KEY, value: out.length ? JSON.stringify(out) : null });
  }

  if ("constructionCaps" in b) {
    const v = b.constructionCaps;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      return { ok: false, error: "Construction caps must be an object keyed by scope." };
    }
    for (const [scope, raw] of Object.entries(v as Record<string, unknown>)) {
      if (!(CAP_SCOPES as readonly string[]).includes(scope)) {
        return { ok: false, error: `Unknown caps scope "${scope}".` };
      }
      const r = validateCaps(scope, raw);
      if ("error" in r) return { ok: false, error: r.error };
      // snake_case + 2-tuple beta_range: what getCaps / cash-deploy parse.
      writes.push({
        key: constructionCapsKey(scope as CapScope),
        value: JSON.stringify({
          top1_max: r.caps.top1Max,
          top3_max: r.caps.top3Max,
          sector_max: r.caps.sectorMax,
          beta_range: [r.caps.betaMin, r.caps.betaMax],
        }),
      });
    }
  }

  db.transaction(() => {
    for (const w of writes) {
      if (w.value === null) {
        db.prepare("DELETE FROM settings WHERE key = ?").run(w.key);
      } else {
        db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(w.key, w.value);
      }
    }
  })();

  return { ok: true, data: getAppPreferences(db) };
}
