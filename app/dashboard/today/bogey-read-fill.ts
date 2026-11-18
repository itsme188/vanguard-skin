/**
 * The bogeys edit box's pure half (bogey intake 2026-11-18, Task F).
 *
 * - `parseManualBogeyForm` reads the manual form the way people write figures
 *   (`readDeskFigure`: "~$3.35B", "3.35bn", "c. 6%", "±6%"), and refuses a
 *   range or a word with a sentence naming the field.
 * - `extraRowsToJson` reads each extra metric's consensus and whisper in its
 *   own row's unit and sends NUMBERS, so the shared parser the route runs
 *   (`parseExtraMetrics`) sees exactly what the desk meant.
 * - `fillFormFromRead` puts a read from a file or pasted text into the boxes:
 *   empty boxes only, never over what the desk typed, and nothing is saved.
 *
 * Pure: no React, and the modal is never imported here, so tests read it
 * without rendering. The modal is a client file, so every server-tree import
 * here is either on the client-safe list or `import type`.
 */
import { formatDeskFigure, readDeskFigure, type DeskFigureKind } from "@/lib/earnings/desk-figure";
import type { ReadBogeysResult } from "@/lib/earnings/read-bogeys-types";
import type { ExtraMetricSpec } from "@/lib/print-watch/extra-metrics";

export interface FormState {
  source_label: string;
  eps_consensus: string;
  eps_whisper: string;
  revenue_consensus: string;
  revenue_whisper: string;
  expected_move: string;
  guidance_notes: string;
  notes: string;
}

/**
 * One desk-defined extra metric line while it is being edited (spec §4.7).
 * Rows hold the desk's TEXT; `extraRowsToJson` reads each number in its row's
 * own unit at save time (a pct row's "27.5%" is 27.5, never a dollar figure).
 */
export interface ExtraRow {
  id: string;
  label: string;
  definition: string;
  unit: ExtraMetricSpec["unit"];
  kind: ExtraMetricSpec["kind"];
  period: ExtraMetricSpec["period"];
  basis: ExtraMetricSpec["basis"];
  consensus: string;
  whisper: string;
}

export interface ManualBogeyValues {
  eps_consensus: number | null;
  eps_whisper: number | null;
  revenue_consensus_usd: number | null;
  revenue_whisper_usd: number | null;
  expected_move_pct: number | null;
  guidance_notes: string | null;
  notes: string | null;
}

type NumberField = "eps_consensus" | "eps_whisper" | "revenue_consensus" | "revenue_whisper" | "expected_move";
type ValueKey = Exclude<keyof ManualBogeyValues, "guidance_notes" | "notes">;

/** The five figure boxes: their form key, stored key, owner-facing name and how they are read. */
const NUMBER_FIELDS: ReadonlyArray<{ field: NumberField; key: ValueKey; name: string; kind: DeskFigureKind }> = [
  { field: "eps_consensus", key: "eps_consensus", name: "EPS consensus", kind: "per_share" },
  { field: "eps_whisper", key: "eps_whisper", name: "EPS whisper", kind: "per_share" },
  { field: "revenue_consensus", key: "revenue_consensus_usd", name: "Revenue consensus", kind: "usd" },
  { field: "revenue_whisper", key: "revenue_whisper_usd", name: "Revenue whisper", kind: "usd" },
  { field: "expected_move", key: "expected_move_pct", name: "Expected move", kind: "pct" },
];

const TEXT_FIELDS: ReadonlyArray<{ field: "guidance_notes" | "notes"; name: string }> = [
  { field: "guidance_notes", name: "Guidance bogeys" },
  { field: "notes", name: "Notes" },
];

/** How a figure reads back to the desk: "108.5B", "1.07", "6%". */
function shown(value: number, kind: DeskFigureKind): string {
  const text = formatDeskFigure(value, kind);
  return kind === "pct" ? `${text}%` : text;
}

/** "Revenue whisper: read “108.5B+” as 108.5B" — said whenever an approximator was dropped. */
function approximation(name: string, raw: string, value: number, kind: DeskFigureKind): string {
  return `${name}: read “${raw.trim()}” as ${shown(value, kind)}`;
}

/**
 * Reads the manual-bogeys form. A field that is typed but cannot be read is an
 * ERROR naming that field ("<Field>: <reader's sentence>"), never "no value":
 * dropping it stored a row with none of the numbers the desk typed (qa:
 * unparseable-values-silently-dropped). `empty` is true when no figure,
 * guidance or note was entered (extra metric rows are judged by the caller).
 * `approximations` lists each figure whose "~", "c.", "+"… was read past.
 */
export function parseManualBogeyForm(form: {
  eps_consensus: string;
  eps_whisper: string;
  revenue_consensus: string;
  revenue_whisper: string;
  expected_move: string;
  guidance_notes: string;
  notes: string;
}): { values: ManualBogeyValues; error: string | null; empty: boolean; approximations: string[] } {
  const values: ManualBogeyValues = {
    eps_consensus: null,
    eps_whisper: null,
    revenue_consensus_usd: null,
    revenue_whisper_usd: null,
    expected_move_pct: null,
    guidance_notes: form.guidance_notes.trim() || null,
    notes: form.notes.trim() || null,
  };
  let error: string | null = null;
  const approximations: string[] = [];
  for (const { field, key, name, kind } of NUMBER_FIELDS) {
    const raw = form[field];
    const read = readDeskFigure(raw, kind);
    if (read.error) {
      error ??= `${name}: ${read.error}`;
      continue;
    }
    if (read.value === null) continue;
    let value = read.value;
    if (key === "expected_move_pct") {
      // A move is a size, not a direction: stored as its absolute value, and
      // zero is not a move (the rule the old coercePercent reader kept).
      if (value === 0) {
        error ??= `${name}: Enter a percent above zero, like 6 or ±6%.`;
        continue;
      }
      value = Math.abs(value);
    }
    values[key] = value;
    if (read.approximate) approximations.push(approximation(name, raw, value, kind));
  }
  const empty = Object.values(values).every((v) => v == null);
  return { values, error, empty, approximations };
}

/**
 * The extra rows as the save sends them. Each consensus and whisper is read
 * with `readDeskFigure` in its row's own unit and sent as a NUMBER (or null
 * when blank); the route then validates with the same `parseExtraMetrics` the
 * modal runs. A refusal names the metric by position and the field:
 * "Metric 2 whisper: That looks like a range …". Any refusal → `json: null`.
 */
export function extraRowsToJson(rows: ExtraRow[]): {
  json: string | null;
  errors: string[];
  approximations: string[];
} {
  const errors: string[] = [];
  const approximations: string[] = [];
  if (rows.length === 0) return { json: null, errors, approximations };
  const out = rows.map((r, i) => {
    const figure = (field: "consensus" | "whisper"): number | null => {
      const name = `Metric ${i + 1} ${field}`;
      const read = readDeskFigure(r[field], r.unit);
      if (read.error) {
        errors.push(`${name}: ${read.error}`);
        return null;
      }
      if (read.value !== null && read.approximate) {
        approximations.push(approximation(name, r[field], read.value, r.unit));
      }
      return read.value;
    };
    return {
      id: r.id,
      label: r.label.trim(),
      definition: r.definition.trim(),
      unit: r.unit,
      kind: r.kind,
      period: r.period,
      basis: r.basis,
      consensus: figure("consensus"),
      whisper: figure("whisper"),
    };
  });
  return { json: errors.length > 0 ? null : JSON.stringify(out), errors, approximations };
}

/** One stored figure as desk text for an edit box, or "" for none. */
function deskText(value: number | null | undefined, kind: DeskFigureKind): string {
  return typeof value === "number" && Number.isFinite(value) ? formatDeskFigure(value, kind) : "";
}

/** Does a typed box already say this number? Then the read is no news. */
function sameFigure(typed: string, value: number, kind: DeskFigureKind): boolean {
  return readDeskFigure(typed, kind).value === value;
}

/**
 * Puts a read into the edit box. Empty boxes only: a typed value is kept and
 * listed in `keptYours` (unless it already says the same number). The source
 * label is set when blank. A watch line with a NEW id is appended; one whose id
 * is already a row fills that row's blank consensus or whisper only. Names in
 * `filled` / `keptYours` are the box names the desk sees. Inputs are never
 * mutated; nothing is saved.
 */
export function fillFormFromRead(
  form: FormState,
  rows: ExtraRow[],
  read: ReadBogeysResult,
): { form: FormState; rows: ExtraRow[]; filled: string[]; keptYours: string[] } {
  const filled: string[] = [];
  const keptYours: string[] = [];
  if (!read.found) return { form: { ...form }, rows: rows.map((r) => ({ ...r })), filled, keptYours };

  const next: FormState = { ...form };
  if (next.source_label.trim() === "" && read.suggestedLabel.trim() !== "") {
    next.source_label = read.suggestedLabel;
    filled.push("Source label");
  }
  for (const { field, key, name, kind } of NUMBER_FIELDS) {
    const value = read.values[key];
    if (value === null || !Number.isFinite(value)) continue;
    // A 0 expected move is not a move; Save would refuse it (review w2 #6).
    if (key === "expected_move_pct" && value === 0) continue;
    if (next[field].trim() === "") {
      next[field] = formatDeskFigure(value, kind);
      filled.push(name);
    } else if (!sameFigure(next[field], value, kind)) {
      keptYours.push(name);
    }
  }
  for (const { field, name } of TEXT_FIELDS) {
    const value = read.values[field]?.trim();
    if (!value) continue;
    if (next[field].trim() === "") {
      next[field] = value;
      filled.push(name);
    } else if (next[field].trim() !== value) {
      keptYours.push(name);
    }
  }

  const nextRows = rows.map((r) => ({ ...r }));
  for (const spec of read.extraMetrics) {
    const at = nextRows.findIndex((r) => r.id === spec.id);
    if (at === -1) {
      nextRows.push({
        id: spec.id,
        label: spec.label,
        definition: spec.definition,
        unit: spec.unit,
        kind: spec.kind,
        period: spec.period,
        basis: spec.basis,
        consensus: deskText(spec.consensus, spec.unit),
        whisper: deskText(spec.whisper, spec.unit),
      });
      filled.push(spec.label);
      continue;
    }
    const target = nextRows[at];
    // Same id, different unit: the owner changed this row's unit. Writing the
    // read's number in the row's unit would turn dollars into a percent or the
    // reverse, so the row is left alone and reported (review w2 #3).
    if (target.unit !== spec.unit) {
      keptYours.push(`${target.label.trim() || spec.label} (its unit differs from the read)`);
      continue;
    }
    for (const part of ["consensus", "whisper"] as const) {
      const value = spec[part];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const name = `${target.label.trim() || spec.label} ${part}`;
      if (target[part].trim() === "") {
        target[part] = formatDeskFigure(value, target.unit);
        filled.push(name);
      } else if (!sameFigure(target[part], value, target.unit)) {
        keptYours.push(name);
      }
    }
  }
  return { form: next, rows: nextRows, filled, keptYours };
}

/** The panel's line after a read that found figures. */
export function describeReadFill(filled: string[], keptYours: string[]): string {
  if (filled.length === 0 && keptYours.length === 0) {
    return "Nothing new to fill: the boxes already hold these figures.";
  }
  const parts = [filled.length > 0 ? `Filled: ${filled.join(", ")}` : "Nothing filled"];
  if (keptYours.length > 0) parts.push(`Kept your: ${keptYours.join(", ")}`);
  return `${parts.join(" · ")} — check and Save.`;
}
