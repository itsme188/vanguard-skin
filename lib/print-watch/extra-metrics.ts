/**
 * Desk-defined extra metric lines (spec §4.7). The desk stores an array of
 * these per bogey row in `earnings_bogeys.extra_metrics_json`; `compileContracts`
 * turns each merged id into one sheet line `x_<uuid>_<period>`.
 *
 * PURE and CLIENT-SAFE by contract: this module is on the allowlist in
 * tests/repo/print-watch-import-boundaries.test.ts, so it may import nothing
 * but `./types` — not even a type-only import of the sqlite driver package
 * (the guard is a text scan, so even a quoted example specifier in a comment
 * would trip it). The bogeys modal validates with the same code the route
 * validates with, which is the whole point of keeping it pure.
 */
import type { LineContract } from "./types";

export type ExtraMetricUnit = "usd" | "per_share" | "pct" | "count";
export type ExtraMetricKind = "point" | "range";
export type ExtraMetricPeriod = "Q" | "NQ_guide" | "FY_guide";
export type ExtraMetricBasis = "gaap" | "non_gaap" | "na";

export interface ExtraMetricSpec {
  id: string;
  label: string;
  definition: string;
  unit: ExtraMetricUnit;
  kind: ExtraMetricKind;
  period: ExtraMetricPeriod;
  basis: ExtraMetricBasis;
  consensus?: number | null;
  whisper?: number | null;
}

export const SEMANTIC_FIELDS = ["unit", "kind", "period", "basis"] as const;

const UNITS: ExtraMetricUnit[] = ["usd", "per_share", "pct", "count"];
const KINDS: ExtraMetricKind[] = ["point", "range"];
const PERIODS: ExtraMetricPeriod[] = ["Q", "NQ_guide", "FY_guide"];
const BASES: ExtraMetricBasis[] = ["gaap", "non_gaap", "na"];

const ALLOWED_KEYS = new Set([
  "id", "label", "definition", "unit", "kind", "period", "basis", "consensus", "whisper",
]);

export const MAX_LABEL = 60;
export const MAX_DEFINITION = 300;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Accepted spellings, per unit. `usd` mirrors lib/format.ts::parseLargeUSD —
 * optional sign, optional `$`, digits with thousands commas, optional decimals,
 * optional k/m/b scale word — so "$3,850,000,000", "3.85B" and "850M" all parse
 * and "6%", "1e3" and "three billion" do not. The scale word is the ONLY
 * multiplier: nothing here ever scales a percent.
 *
 * ONE deliberate divergence (R-F16), enforced below rather than in the regex:
 * a mantissa with no digit in it ("," / "$,,," / ",.5") is an ERROR here, where
 * parseLargeUSD returns 0. See the comment at the check for why.
 */
const USD_GRAMMAR = /^(-?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([bmk])?\s*$/i;
/**
 * per_share / count / pct: a plain decimal, nothing else. An explicit leading
 * `+` is accepted because lib/format.ts::coercePercent (the repo's other manual
 * percent reader, used by the existing bogey fields) accepts it — a desk that
 * types `+27.5` must not get two different answers from two adjacent inputs.
 * `Number("+27.5")` is 27.5, so nothing downstream changes.
 */
const DECIMAL_GRAMMAR = /^[-+]?\d+(\.\d+)?$/;

const UNIT_HINT: Record<ExtraMetricUnit, string> = {
  usd: "a dollar figure like 3.85B, 850M or $3,850,000,000",
  per_share: "a plain decimal like 0.46",
  pct: "a plain decimal, with an optional trailing % (like 27.5 or 27.5%)",
  count: "a plain whole or decimal number",
};

/**
 * ONE number field, parsed against its row's unit. NEVER `Number(raw)`:
 * coercion is what turns `true` into 1 and "  " into 0.
 *
 * Empty is not an error — a desk that has a definition but no consensus yet is
 * the ordinary case, and `null` is how the sheet says "no bogey on this line".
 * `undefined` is returned ONLY to signal "an error was recorded"; the caller
 * marks the row bad and drops it.
 */
function readNumberForUnit(
  raw: unknown,
  unit: ExtraMetricUnit,
  index: number,
  field: string,
  errors: string[],
): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      errors.push(`Metric ${index}: ${field} must be a finite number or empty.`);
      return undefined;
    }
    return raw;
  }
  if (typeof raw !== "string") {
    // A boolean, an object, an array. Number() would happily coerce the first.
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  const text = raw.trim();
  if (text === "") return null;          // blank / whitespace-only: no bogey, not zero

  if (unit === "usd") {
    const m = USD_GRAMMAR.exec(text);
    if (!m) {
      errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT.usd}, or empty.`);
      return undefined;
    }
    const sign = m[1] === "-" ? -1 : 1;
    const mantissa = m[2].replace(/,/g, "");
    // DELIBERATE DIVERGENCE from lib/format.ts::parseLargeUSD (ruling R-F16).
    // `[\d,]+` happily matches a run of commas with no digit in it, so ","
    // and "$,,," strip to "" and `Number("")` is 0 — a finite, accepted value.
    // parseLargeUSD carries the same hole; here it would turn a keystroke slip
    // into a $0 consensus the desk gets measured against at 16:05, and $0 is
    // not a small number, it is a wrong number presented as a measurement.
    // Requiring digits BEFORE the decimal point also rejects ",.5" (which does
    // contain a digit). Comma PLACEMENT is deliberately left alone — "1,2,3"
    // still reads as 123, exactly as parseLargeUSD reads it, because that value
    // is transcribed rather than invented. Do not "fix" parseLargeUSD instead:
    // other callers depend on its current behaviour, and this module is pure.
    if (!/^\d+(\.\d+)?$/.test(mantissa)) {
      errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT.usd}, or empty.`);
      return undefined;
    }
    const numeric = Number(mantissa);
    if (!Number.isFinite(numeric)) {
      errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT.usd}, or empty.`);
      return undefined;
    }
    const suffix = m[3]?.toLowerCase();
    const multiplier = suffix === "b" ? 1_000_000_000 : suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
    return sign * numeric * multiplier;
  }

  // pct may carry ONE trailing '%', which is stripped and never scaled: 27.5%
  // and 27.5 are the same percentage, and dividing by 100 here would silently
  // change the bogey the desk typed.
  const body = unit === "pct" && text.endsWith("%") ? text.slice(0, -1).trim() : text;
  if (!DECIMAL_GRAMMAR.test(body)) {
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  const n = Number(body);
  if (!Number.isFinite(n)) {
    errors.push(`Metric ${index}: ${field} must be ${UNIT_HINT[unit]}, or empty.`);
    return undefined;
  }
  return n;
}

/**
 * ALL-OR-NOTHING: if ANY metric on the row fails ANY check, `specs` comes back
 * EMPTY — not "the rows that passed". A caller that ignores `errors` therefore
 * compiles no extra lines at all for that bogey row rather than a partial sheet,
 * which is the safe direction for a set of numbers a print is measured against.
 * The write path validates first, so a stored row that fails here is already an
 * anomaly; `errors` is what the modal renders.
 */
export function parseExtraMetrics(json: string | null): { specs: ExtraMetricSpec[]; errors: string[] } {
  if (json === null || json.trim() === "") return { specs: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { specs: [], errors: ["Extra metrics must be valid JSON."] };
  }
  if (!Array.isArray(parsed)) return { specs: [], errors: ["Extra metrics must be a JSON array."] };

  const errors: string[] = [];
  const specs: ExtraMetricSpec[] = [];
  const seen = new Set<string>();

  parsed.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`Metric ${n}: each entry must be an object.`);
      return;
    }
    const row = raw as Record<string, unknown>;
    let bad = false;

    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key)) {
        errors.push(`Metric ${n}: unknown field "${key}".`);
        bad = true;
      }
    }
    const id = typeof row.id === "string" ? row.id : "";
    if (!isUuidV4(id)) {
      errors.push(`Metric ${n}: id must be a full uuid (v4).`);
      bad = true;
    } else if (seen.has(id)) {
      errors.push(`Metric ${n}: id ${id} appears twice on this sheet.`);
      bad = true;
    } else {
      // Recorded as soon as the id itself is well-formed, BEFORE the row's other
      // checks can bail out (M-6): otherwise a first occurrence that also failed
      // something else hides the duplicate until the desk's next submit.
      seen.add(id);
    }
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label.length < 1 || label.length > MAX_LABEL) {
      errors.push(`Metric ${n}: label must be 1 to ${MAX_LABEL} characters.`);
      bad = true;
    }
    // Absent / null stays the legal "no definition" case; a present-but-wrong
    // type must NOT collapse to "" — the definition is the text the extractor
    // searches the release with, so silently blanking it yields a compiled line
    // that can never be found, with no trace of why.
    if (row.definition !== undefined && row.definition !== null && typeof row.definition !== "string") {
      errors.push(`Metric ${n}: definition must be text.`);
      bad = true;
    }
    const definition = typeof row.definition === "string" ? row.definition.trim() : "";
    if (definition.length > MAX_DEFINITION) {
      errors.push(`Metric ${n}: definition must be ${MAX_DEFINITION} characters or fewer.`);
      bad = true;
    }
    if (!UNITS.includes(row.unit as ExtraMetricUnit)) {
      errors.push(`Metric ${n}: unit must be one of ${UNITS.join(", ")}.`);
      bad = true;
    }
    if (!KINDS.includes(row.kind as ExtraMetricKind)) {
      errors.push(`Metric ${n}: kind must be one of ${KINDS.join(", ")}.`);
      bad = true;
    }
    if (!PERIODS.includes(row.period as ExtraMetricPeriod)) {
      errors.push(`Metric ${n}: period must be one of ${PERIODS.join(", ")}.`);
      bad = true;
    }
    if (!BASES.includes(row.basis as ExtraMetricBasis)) {
      errors.push(`Metric ${n}: basis must be one of ${BASES.join(", ")}.`);
      bad = true;
    }

    // The unit decides how the numbers are read, so a row with a bad unit is
    // already unusable and its numbers are not second-guessed.
    const unitOk = UNITS.includes(row.unit as ExtraMetricUnit);
    const consensus = unitOk
      ? readNumberForUnit(row.consensus, row.unit as ExtraMetricUnit, n, "consensus", errors)
      : null;
    const whisper = unitOk
      ? readNumberForUnit(row.whisper, row.unit as ExtraMetricUnit, n, "whisper", errors)
      : null;
    if (consensus === undefined || whisper === undefined) bad = true;
    if (bad) return;

    specs.push({
      id,
      label,
      definition,
      unit: row.unit as ExtraMetricUnit,
      kind: row.kind as ExtraMetricKind,
      period: row.period as ExtraMetricPeriod,
      basis: row.basis as ExtraMetricBasis,
      consensus: consensus ?? null,
      whisper: whisper ?? null,
    });
  });

  return { specs: errors.length > 0 ? [] : specs, errors };
}

export function detectExtraMetricConflicts(
  rows: Array<{ id: number; specs: ExtraMetricSpec[] }>,
): Array<{ id: string; fields: string[] }> {
  const first = new Map<string, ExtraMetricSpec>();
  const disagreeing = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const s of row.specs) {
      const seen = first.get(s.id);
      if (!seen) {
        first.set(s.id, s);
        continue;
      }
      for (const f of SEMANTIC_FIELDS) {
        if (seen[f] !== s[f]) {
          const set = disagreeing.get(s.id) ?? new Set<string>();
          set.add(f);
          disagreeing.set(s.id, set);
        }
      }
    }
  }
  return [...disagreeing.entries()]
    .map(([id, fields]) => ({ id, fields: [...fields].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function mergeExtraMetrics(
  rows: Array<{ id: number; sourceLabel: string | null; specs: ExtraMetricSpec[] }>,
): {
  specs: ExtraMetricSpec[];
  conflicts: Array<{ id: string; fields: string[] }>;
  sourceLabelById: Record<string, string | null>;
} {
  const conflicts = detectExtraMetricConflicts(rows);
  const blocked = new Set(conflicts.map((c) => c.id));
  const order: string[] = [];
  const merged = new Map<string, ExtraMetricSpec>();
  const sourceLabelById: Record<string, string | null> = {};

  for (const row of rows) {
    for (const s of row.specs) {
      if (blocked.has(s.id)) continue;
      const seen = merged.get(s.id);
      if (!seen) {
        order.push(s.id);
        merged.set(s.id, { ...s });
        if (s.consensus !== null && s.consensus !== undefined) sourceLabelById[s.id] = row.sourceLabel;
        continue;
      }
      if ((seen.consensus === null || seen.consensus === undefined) && s.consensus !== null && s.consensus !== undefined) {
        seen.consensus = s.consensus;
        sourceLabelById[s.id] = row.sourceLabel;
      }
      if ((seen.whisper === null || seen.whisper === undefined) && s.whisper !== null && s.whisper !== undefined) {
        seen.whisper = s.whisper;
      }
    }
  }
  for (const id of order) if (!(id in sourceLabelById)) sourceLabelById[id] = null;
  return { specs: order.map((id) => merged.get(id)!), conflicts, sourceLabelById };
}

export function extraMetricId(spec: ExtraMetricSpec): string {
  return `x_${spec.id}_${spec.period}`;
}

export function extraMetricUnitToContractUnit(unit: ExtraMetricUnit): LineContract["unit"] {
  return unit === "pct" ? "percent" : unit;
}
