/**
 * The filing summary's model output: the JSON schema the model fills, and the
 * runtime reader of its answer (spec §5, §Figure checking, Codex round 2 R1/R6).
 *
 * The schema describes SHAPE only. Native structured output rejects array
 * count keywords other than minItems 0/1 and every numeric or string
 * constraint (CLAUDE.md "Frontier structured output rejects array count
 * keywords"), so every object node is closed (`additionalProperties: false`),
 * every property is required (nullable instead of optional), and the counts
 * (12 bullets, 3 Top) are enforced here in code by `parseSectionOutput`.
 *
 * `parseSectionOutput` checks every field and enum, refuses duplicate ids,
 * and rebuilds the value from known keys only. It checks no references
 * (a placeholder with no figure, a citation id that is not in the claim, a
 * comparison operand that does not exist): those are per-claim findings the
 * checker reports as statuses, so one bad claim never costs the whole section.
 */
import type {
  Basis,
  ComputeOp,
  FigureScale,
  FigureSourceKind,
  FigureUnit,
  ModelBullet,
  ModelCitation,
  ModelClaim,
  ModelComparison,
  ModelFigure,
  ModelSectionOutput,
  PeriodAnchor,
  PeriodKind,
  PeriodSpec,
  Relation,
} from "@/lib/filing-summary/types";

/** Bumped whenever the schema or its reader changes meaning; stored per section (R14). */
export const SCHEMA_VERSION = 1;

/** Code-enforced caps (spec §5); the schema cannot carry them. */
export const MAX_BULLETS = 12;
export const MAX_TOP = 3;

export const FIGURE_UNITS: readonly FigureUnit[] = ["usd", "usd_per_share", "percent", "shares", "count", "people", "other"];
export const FIGURE_SCALES: readonly FigureScale[] = ["units", "thousands", "millions", "billions"];
export const PERIOD_KINDS: readonly PeriodKind[] = ["quarter", "year_to_date", "fiscal_year", "instant"];
export const PERIOD_ROLES: readonly PeriodSpec["role"][] = ["actual", "outlook"];
export const PERIOD_ANCHORS: readonly Exclude<PeriodAnchor, null>[] = ["reported_quarter", "next_quarter", "fiscal_year"];
export const BASES: readonly Basis[] = [
  "reported", "non_gaap", "constant_currency", "excluding_item",
  "guidance_low", "guidance_high", "guidance_mid", "unknown",
];
export const SOURCE_KINDS: readonly FigureSourceKind[] = ["quote", "bogey", "computed"];
export const COMPUTE_OPS: readonly ComputeOp[] = ["difference", "sum", "ratio", "growth"];
export const RELATIONS: readonly Relation[] = ["above", "below", "in_line", "raised", "lowered", "narrowed", "unchanged"];

// ── JSON schema ──────────────────────────────────────────────────────────

type Node = Record<string, unknown>;

/** A closed object node with every property required. */
function obj(properties: Record<string, Node>): Node {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
const str: Node = { type: "string" };
const nullableStr: Node = { type: ["string", "null"] };
const num: Node = { type: "number" };
const bool: Node = { type: "boolean" };
const enumOf = (values: readonly string[]): Node => ({ type: "string", enum: [...values] });
const nullableEnumOf = (values: readonly string[]): Node => ({ anyOf: [enumOf(values), { type: "null" }] });
const arrayOf = (items: Node): Node => ({ type: "array", items });

const PERIOD_SCHEMA = obj({
  kind: enumOf(PERIOD_KINDS),
  role: enumOf(PERIOD_ROLES),
  endDate: { ...nullableStr, description: "YYYY-MM-DD period end date, or null when the source does not state it." },
  fiscalYear: { type: ["integer", "null"] },
  fiscalQuarter: { type: ["integer", "null"], description: "1 to 4, or null." },
  anchor: nullableEnumOf(PERIOD_ANCHORS),
  label: { ...str, description: "Plain period label, e.g. \"Q3 2026\", \"nine months 2026\", \"FY 2027 outlook\"." },
});

const FIGURE_SCHEMA = obj({
  id: { ...str, description: "Unique in the section, e.g. f1. Referenced as {f1} in the claim text." },
  valueText: { ...str, description: "Exactly how the figure is shown in the claim, e.g. \"$12.99 billion\", \"26%\"." },
  value: { ...num, description: "The number at `scale`, e.g. 12.99 with scale billions." },
  unit: enumOf(FIGURE_UNITS),
  scale: enumOf(FIGURE_SCALES),
  metric: str,
  period: PERIOD_SCHEMA,
  basis: enumOf(BASES),
  basisNote: nullableStr,
  sourceKind: enumOf(SOURCE_KINDS),
  citationId: nullableStr,
  label: { ...nullableStr, description: "For a quote figure: the exact row label or phrase that names it." },
  bogeyKey: nullableStr,
  operation: nullableEnumOf(COMPUTE_OPS),
  inputs: arrayOf(str),
});

const CITATION_SCHEMA = obj({
  id: { ...str, description: "Unique in the section, e.g. q1." },
  document: { ...str, description: "The document's file name exactly as given." },
  quote: str,
  isTableRow: bool,
});

const COMPARISON_SCHEMA = obj({
  left: str,
  leftHigh: nullableStr,
  right: str,
  rightHigh: nullableStr,
  relation: enumOf(RELATIONS),
});

const CLAIM_SCHEMA = obj({
  id: { ...str, description: "Unique in the section, e.g. c1." },
  text: str,
  citations: arrayOf(CITATION_SCHEMA),
  figures: arrayOf(FIGURE_SCHEMA),
  comparisons: arrayOf(COMPARISON_SCHEMA),
  corrects: { anyOf: [obj({ claimId: str, citationId: str }), { type: "null" }] },
});

const BULLET_SCHEMA = obj({
  top: bool,
  routine: bool,
  claims: arrayOf(CLAIM_SCHEMA),
});

/** The shape of `ModelSectionOutput`; the caller wraps it with the AI SDK's `jsonSchema()`. */
export const SECTION_JSON_SCHEMA: Record<string, unknown> = obj({
  headline: str,
  bullets: arrayOf(BULLET_SCHEMA),
});

// ── Runtime reader ───────────────────────────────────────────────────────

class Invalid extends Error {}

function fail(path: string, what: string): never {
  throw new Invalid(`${path}: ${what}`);
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(path, "must be an object");
  return v as Record<string, unknown>;
}

function field(o: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in o)) fail(`${path}.${key}`, "is missing");
  return o[key];
}

function readString(o: Record<string, unknown>, key: string, path: string, nonEmpty = false): string {
  const v = field(o, key, path);
  if (typeof v !== "string") fail(`${path}.${key}`, "must be a string");
  if (nonEmpty && v.trim() === "") fail(`${path}.${key}`, "must not be empty");
  return v;
}

function readNullableString(o: Record<string, unknown>, key: string, path: string): string | null {
  const v = field(o, key, path);
  if (v === null) return null;
  if (typeof v !== "string") fail(`${path}.${key}`, "must be a string or null");
  return v;
}

function readBool(o: Record<string, unknown>, key: string, path: string): boolean {
  const v = field(o, key, path);
  if (typeof v !== "boolean") fail(`${path}.${key}`, "must be true or false");
  return v;
}

function readEnum<T extends string>(o: Record<string, unknown>, key: string, path: string, values: readonly T[]): T {
  const v = field(o, key, path);
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    fail(`${path}.${key}`, `must be one of ${values.join(", ")}`);
  }
  return v as T;
}

function readNullableEnum<T extends string>(o: Record<string, unknown>, key: string, path: string, values: readonly T[]): T | null {
  if (field(o, key, path) === null) return null;
  return readEnum(o, key, path, values);
}

function readNullableInt(o: Record<string, unknown>, key: string, path: string): number | null {
  const v = field(o, key, path);
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`${path}.${key}`, "must be a whole number or null");
  return v;
}

function readArray(o: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = field(o, key, path);
  if (!Array.isArray(v)) fail(`${path}.${key}`, "must be an array");
  return v;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readPeriod(raw: unknown, path: string): PeriodSpec {
  const o = record(raw, path);
  const endDate = readNullableString(o, "endDate", path);
  if (endDate !== null && !DATE_RE.test(endDate)) fail(`${path}.endDate`, "must be YYYY-MM-DD or null");
  const fiscalQuarter = readNullableInt(o, "fiscalQuarter", path);
  if (fiscalQuarter !== null && (fiscalQuarter < 1 || fiscalQuarter > 4)) fail(`${path}.fiscalQuarter`, "must be 1 to 4 or null");
  return {
    kind: readEnum(o, "kind", path, PERIOD_KINDS),
    role: readEnum(o, "role", path, PERIOD_ROLES),
    endDate,
    fiscalYear: readNullableInt(o, "fiscalYear", path),
    fiscalQuarter,
    anchor: readNullableEnum(o, "anchor", path, PERIOD_ANCHORS),
    label: readString(o, "label", path),
  };
}

function readFigure(raw: unknown, path: string): ModelFigure {
  const o = record(raw, path);
  const value = field(o, "value", path);
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${path}.value`, "must be a finite number");
  const inputs = readArray(o, "inputs", path).map((v, i) => {
    if (typeof v !== "string") fail(`${path}.inputs[${i}]`, "must be a string");
    return v;
  });
  return {
    id: readString(o, "id", path, true),
    valueText: readString(o, "valueText", path, true),
    value,
    unit: readEnum(o, "unit", path, FIGURE_UNITS),
    scale: readEnum(o, "scale", path, FIGURE_SCALES),
    metric: readString(o, "metric", path),
    period: readPeriod(field(o, "period", path), `${path}.period`),
    basis: readEnum(o, "basis", path, BASES),
    basisNote: readNullableString(o, "basisNote", path),
    sourceKind: readEnum(o, "sourceKind", path, SOURCE_KINDS),
    citationId: readNullableString(o, "citationId", path),
    label: readNullableString(o, "label", path),
    bogeyKey: readNullableString(o, "bogeyKey", path),
    operation: readNullableEnum(o, "operation", path, COMPUTE_OPS),
    inputs,
  };
}

function readCitation(raw: unknown, path: string): ModelCitation {
  const o = record(raw, path);
  return {
    id: readString(o, "id", path, true),
    document: readString(o, "document", path, true),
    quote: readString(o, "quote", path, true),
    isTableRow: readBool(o, "isTableRow", path),
  };
}

function readComparison(raw: unknown, path: string): ModelComparison {
  const o = record(raw, path);
  return {
    left: readString(o, "left", path, true),
    leftHigh: readNullableString(o, "leftHigh", path),
    right: readString(o, "right", path, true),
    rightHigh: readNullableString(o, "rightHigh", path),
    relation: readEnum(o, "relation", path, RELATIONS),
  };
}

function readClaim(raw: unknown, path: string): ModelClaim {
  const o = record(raw, path);
  const correctsRaw = field(o, "corrects", path);
  let corrects: ModelClaim["corrects"] = null;
  if (correctsRaw !== null) {
    const c = record(correctsRaw, `${path}.corrects`);
    corrects = {
      claimId: readString(c, "claimId", `${path}.corrects`, true),
      citationId: readString(c, "citationId", `${path}.corrects`, true),
    };
  }
  return {
    id: readString(o, "id", path, true),
    text: readString(o, "text", path, true),
    citations: readArray(o, "citations", path).map((c, i) => readCitation(c, `${path}.citations[${i}]`)),
    figures: readArray(o, "figures", path).map((f, i) => readFigure(f, `${path}.figures[${i}]`)),
    comparisons: readArray(o, "comparisons", path).map((c, i) => readComparison(c, `${path}.comparisons[${i}]`)),
    corrects,
  };
}

function readBullet(raw: unknown, path: string): ModelBullet {
  const o = record(raw, path);
  return {
    top: readBool(o, "top", path),
    routine: readBool(o, "routine", path),
    claims: readArray(o, "claims", path).map((c, i) => readClaim(c, `${path}.claims[${i}]`)),
  };
}

/** Claim, citation and figure ids are each unique across the whole section. */
function checkUniqueIds(bullets: ModelBullet[]): void {
  const seen = { claim: new Set<string>(), citation: new Set<string>(), figure: new Set<string>() };
  const add = (kind: keyof typeof seen, id: string) => {
    if (seen[kind].has(id)) fail("$", `duplicate ${kind} id "${id}"`);
    seen[kind].add(id);
  };
  for (const b of bullets) {
    for (const c of b.claims) {
      add("claim", c.id);
      for (const q of c.citations) add("citation", q.id);
      for (const f of c.figures) add("figure", f.id);
    }
  }
}

export type ParseSectionResult =
  | { ok: true; value: ModelSectionOutput; notes: string[] }
  | { ok: false; error: string };

/**
 * Validates the model's answer and applies the code-enforced caps. Order:
 * shape and enums (any failure → invalid), drop bullets with no claims, keep
 * the first 12 bullets, keep `top` on the first three Top bullets and demote
 * the rest, then refuse duplicate ids among what is kept. Every adjustment is
 * described in `notes`.
 */
export function parseSectionOutput(raw: unknown): ParseSectionResult {
  try {
    const o = record(raw, "$");
    const headline = readString(o, "headline", "$", true);
    const all = readArray(o, "bullets", "$").map((b, i) => readBullet(b, `$.bullets[${i}]`));
    const notes: string[] = [];

    let bullets = all.filter((b) => b.claims.length > 0);
    if (bullets.length < all.length) {
      notes.push(`Dropped ${all.length - bullets.length} bullet(s) with no claims.`);
    }
    if (bullets.length > MAX_BULLETS) {
      notes.push(`Kept the first ${MAX_BULLETS} of ${bullets.length} bullets; the rest were dropped.`);
      bullets = bullets.slice(0, MAX_BULLETS);
    }
    let tops = 0;
    let demoted = 0;
    bullets = bullets.map((b) => {
      if (!b.top) return b;
      tops += 1;
      if (tops <= MAX_TOP) return b;
      demoted += 1;
      return { ...b, top: false };
    });
    if (demoted > 0) notes.push(`Demoted ${demoted} bullet(s) marked Top beyond the first ${MAX_TOP}.`);

    checkUniqueIds(bullets);
    return { ok: true, value: { headline, bullets }, notes };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}
