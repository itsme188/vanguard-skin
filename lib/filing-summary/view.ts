/**
 * The filing summary's read model (spec §9, §11, R13, Hardening 4, 6, 14):
 * what the print-row panel (`PanelView`) and the full summary page
 * (`FullView`) show, built from the store and nothing else. Read-only: no
 * function here writes.
 *
 * Rules kept here, once:
 *   - `shown` is the newest DONE run (falling back to the newest run when none
 *     is done); `inProgress` is a newer RUNNING run, so a re-run never hides
 *     the last completed version (Hardening 4).
 *   - A section stored failed with error class `awaiting_retry` (a companion
 *     that arrived after the run failed, R13) reads "waiting for Retry",
 *     never "failed" (controller ruling 4). A run whose only failures are
 *     such sections reads the same.
 *   - An older run lists the time after which it holds no filings
 *     (`excludesAfterEt`) when a newer run has a filing it lacks (R13).
 *   - sec.gov links are rebuilt from the stored CIK, accession and file name
 *     through `secArchiveUrl` / `textFragmentUrl` (Hardening 8), never taken
 *     from stored JSON.
 *   - Privacy (R15): the bogey snapshot leaves as label, value, unit,
 *     provenance and date only. Nothing here reads a portfolio table; the
 *     company name comes from the securities name, public market data.
 *   - Times are Eastern ("4:05 pm"), from `easternClock`.
 */
import type Database from "better-sqlite3";
import { parseStoredTimestamp } from "@/lib/format";
import { familyNowLabel, modelLabel } from "@/lib/ai/model-families";
import { choiceLabel, SUMMARY_CHOICES } from "./choice";
import { countStatuses } from "./evaluate";
import { secArchiveUrl, textFragmentUrl } from "./locate";
import { easternClock } from "./poller";
import {
  getChoice,
  getEventState,
  listDocuments,
  listFilings,
  listRuns,
  listSections,
  type FetchState,
  type FilingRole,
  type FilingRow,
  type IdentityVerdict,
  type PollState,
  type RunRow,
  type RunTrigger,
  type SectionRow,
} from "./store";
import { choiceValue } from "./labels";
import type {
  CheckedClaim,
  CheckedSection,
  ComparisonCheck,
  CoverageEntry,
  ModelFigure,
  ModelSectionOutput,
  FigureUnit,
  Footnote,
  StatusCounts,
  SummaryChoice,
  SummaryEffort,
  SummaryFamily,
} from "./types";

// ---------------------------------------------------------------- types

/** A run's status as shown: `waiting_retry` = its only failures wait for Retry. */
export type RunViewStatus = "running" | "done" | "failed" | "waiting_retry";
/** A section's status as shown: `waiting_retry` = stored failed / awaiting_retry. */
export type SectionViewStatus = "pending" | "running" | "done" | "failed" | "waiting_retry";

/** The error class a waiting companion is stored with (R13; migration 099). */
export const AWAITING_RETRY_CLASS = "awaiting_retry";

/** A bogey's public fields (R15): no notes, no definitions, no row ids. */
export interface OperandBogey {
  label: string;
  value: number;
  unit: FigureUnit;
  provenance: string;
  asOf: string;
}

/** One side of a comparison, as the model stated it, with its source. */
export interface OperandDescriptor {
  figureId: string;
  /** The stated value text, e.g. "$64.601B". */
  displayText: string;
  /** "bogey" for a bogey figure; "filing" for a quoted or computed one. */
  source: "filing" | "bogey";
  /** Set for a bogey figure found in the run's snapshot. */
  bogey?: OperandBogey;
}

/** A comparison check with its operands described (null: the model named a figure it did not supply). */
export interface ViewComparisonCheck extends ComparisonCheck {
  left: OperandDescriptor | null;
  right: OperandDescriptor | null;
  leftHigh?: OperandDescriptor;
  rightHigh?: OperandDescriptor;
}

/** A footnote with, when the quote was not located, the quote as the model gave it. */
export interface ViewFootnote extends Footnote {
  /** The model's quote for a not_found / ambiguous footnote; null when found or unknown. */
  modelQuote: string | null;
}

/** A checked claim with its footnote links rebuilt and its correction mark (Hardening 14). */
export interface ViewClaim extends CheckedClaim {
  footnotes: ViewFootnote[];
  comparisonChecks: ViewComparisonCheck[];
  correction: { claimId: string; resolved: boolean; footnote: ViewFootnote | null } | null;
  /** Set on an earlier claim when a later 8-K/A section's correction resolved. */
  correctedBy: { form: string; acceptedAtEt: string | null } | null;
}

export interface SectionState {
  form: string;
  acceptedAtEt: string | null;
  status: SectionViewStatus;
  errorClass: string | null;
}

export interface RunSummary {
  runId: number;
  runNo: number;
  status: RunViewStatus;
  trigger: RunTrigger;
  /** "Opus 5.5"; the family name when no model was resolved. */
  modelLabel: string;
  effort: SummaryEffort;
  fallbackNote: string | null;
  /** Over every done section's claims (`countStatuses`). */
  counts: StatusCounts;
  /** Any section's coverage skipped or failed a document (Hardening 6). */
  incomplete: boolean;
  /** Up to three Top claims from done sections, in section order. */
  top: ViewClaim[];
  sectionStates: SectionState[];
  /** "4:10 pm": set when a newer run holds a filing this run lacks (R13). */
  excludesAfterEt: string | null;
}

export interface PanelView {
  eventId: number;
  choice: SummaryChoice;
  choiceLabel: string;
  isDefault: boolean;
  locked: boolean;
  /** "Opus · now 5.5" for the current choice's family. */
  nowLabel: string;
  /** Null when the event has no filing-summary state yet. */
  pollState: PollState | null;
  pollDetail: string | null;
  shown: RunSummary | null;
  inProgress: RunSummary | null;
  /** True when Run summary may spend: an accepted earnings filing and no run. */
  runSummaryAvailable: boolean;
  /** What the running run reads now (its running, else first pending, section); null when nothing runs. */
  readingDocs: ReadingDocs | null;
  /** All five picker choices with their now-labels. */
  choiceOptions: ChoiceOption[];
  /**
   * True when there is no accepted earnings filing but an earnings-role
   * filing whose header gave no acceptance time (`time_unconfirmed`) exists:
   * a filing was found, it was not run automatically, and Run summary may
   * still read it on the owner's click.
   */
  earningsTimeUnconfirmed: boolean;
  /** "8-K" or "6-K": the base form of the live earnings filing; null when there is none. */
  earningsForm: "8-K" | "6-K" | null;
}

/** The filing being read and how many fetched exhibits it has: "8-K + 3 exhibits". */
export interface ReadingDocs {
  form: string;
  exhibits: number;
}

export interface ChoiceOption {
  choice: SummaryChoice;
  /** `choiceValue(choice)`: "opus·high". */
  value: string;
  label: string;
  nowLabel: string;
}

export interface PublicBogey {
  key: string;
  label: string;
  value: number;
  unit: FigureUnit;
  provenance: string;
  asOf: string;
}

export interface FullDocument {
  fileName: string;
  docType: string;
  status: "fetched" | "skipped" | "failed";
  skipReason: string | null;
  url: string | null;
}

export interface FullFiling {
  filingId: number;
  accession: string;
  cik: string;
  form: string;
  role: FilingRole;
  /** "4:05 pm" Eastern; null when the header gave no acceptance time. */
  acceptedAtEt: string | null;
  /** "2026-10-22" Eastern. */
  acceptedOnEt: string | null;
  discoveredAtEt: string | null;
  identityVerdict: IdentityVerdict;
  /** e.g. "accepted after 8 pm". */
  identityReason: string | null;
  fetchState: FetchState;
  indexUrl: string | null;
  documents: FullDocument[];
}

export interface FullSection {
  sectionId: number;
  seq: number;
  filingId: number;
  form: string;
  accession: string;
  cik: string;
  acceptedAtEt: string | null;
  acceptedOnEt: string | null;
  status: SectionViewStatus;
  errorClass: string | null;
  /** Short (at most 200 characters). */
  errorText: string | null;
  attempts: number;
  modelLabel: string | null;
  effort: string | null;
  /** Null until the section is done. */
  headline: string | null;
  claims: ViewClaim[];
  counts: StatusCounts | null;
  coverage: CoverageEntry[];
  incomplete: boolean;
  /** Token counts the SDK reported; null when none were stored. */
  usage: Record<string, number> | null;
}

export interface FullRun {
  runId: number;
  runNo: number;
  status: RunViewStatus;
  trigger: RunTrigger;
  family: SummaryFamily;
  effort: SummaryEffort;
  modelLabel: string;
  fallbackNote: string | null;
  createdAtEt: string | null;
  createdOnEt: string | null;
  finishedAtEt: string | null;
  counts: StatusCounts;
  incomplete: boolean;
  excludesAfterEt: string | null;
  /** Summed over sections. */
  usage: Record<string, number>;
  bogeys: PublicBogey[];
  /** "Q3" from this run's earnings section figures; null when they do not agree. */
  quarterLabel: string | null;
  sections: FullSection[];
}

export interface FullView {
  event: {
    eventId: number;
    symbol: string | null;
    companyName: string | null;
    eventDate: string;
    /** The shown run's `quarterLabel`. */
    quarterLabel: string | null;
    pollState: PollState | null;
    pollDetail: string | null;
  };
  choice: {
    current: SummaryChoice;
    label: string;
    isDefault: boolean;
    locked: boolean;
    nowLabel: string;
    options: ChoiceOption[];
  };
  runSummaryAvailable: boolean;
  shownRunId: number | null;
  inProgressRunId: number | null;
  /** Oldest first (run_no ascending). */
  runs: FullRun[];
  filings: FullFiling[];
}

// ---------------------------------------------------------------- time

function etParts(stamp: string | null): { date: string; time: string } | null {
  if (!stamp) return null;
  const d = parseStoredTimestamp(stamp);
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null;
  return easternClock(ms);
}

/** "16:05:00" → "4:05 pm". */
function clock12(time: string): string {
  const [hh, mm] = time.split(":");
  const h = Number(hh);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mm} ${suffix}`;
}

/** A stored instant (ISO or SQLite UTC stamp) as Eastern "4:05 pm"; null when absent or unreadable. */
export function etTime(stamp: string | null): string | null {
  const p = etParts(stamp);
  return p ? clock12(p.time) : null;
}

/** A stored instant's Eastern date, `YYYY-MM-DD`. */
export function etDate(stamp: string | null): string | null {
  return etParts(stamp)?.date ?? null;
}

// ---------------------------------------------------------------- small readers

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shortText(s: string | null): string | null {
  if (s == null) return null;
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

function safeArchiveUrl(cik: string, accession: string, fileName: string): string | null {
  try {
    return secArchiveUrl(cik, accession, fileName);
  } catch {
    return null;
  }
}

/** The filing's EDGAR folder index, from validated parts only. */
function filingIndexUrl(cik: string, accession: string): string | null {
  const base = safeArchiveUrl(cik, accession, "index.htm");
  return base ? base.slice(0, -"index.htm".length) : null;
}

/** Rebuilds a footnote's link from the filing's stored identity (Hardening 8). */
function rebuildFootnote(f: Footnote, cik: string, accession: string): Footnote {
  const base = safeArchiveUrl(cik, accession, f.document);
  let url: string | null = base;
  if (base && f.status === "found" && f.sentence) {
    url = textFragmentUrl(base, f.sentence);
  }
  return { ...f, url };
}

function readUsage(json: string | null): Record<string, number> | null {
  const raw = parseJson<Record<string, unknown>>(json);
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const UNITS: ReadonlySet<string> = new Set([
  "usd", "usd_per_share", "percent", "shares", "count", "people", "other",
]);

/** The snapshot's public fields only (R15); malformed entries are dropped. */
export function publicBogeys(json: string): PublicBogey[] {
  const raw = parseJson<unknown>(json);
  if (!Array.isArray(raw)) return [];
  const out: PublicBogey[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const r = b as Record<string, unknown>;
    if (
      typeof r.key !== "string" || typeof r.label !== "string" ||
      typeof r.value !== "number" || !Number.isFinite(r.value) ||
      typeof r.unit !== "string" || !UNITS.has(r.unit) ||
      typeof r.provenance !== "string" || typeof r.asOf !== "string"
    ) {
      continue;
    }
    out.push({
      key: r.key,
      label: r.label,
      value: r.value,
      unit: r.unit as FigureUnit,
      provenance: r.provenance,
      asOf: r.asOf,
    });
  }
  return out;
}

// ---------------------------------------------------------------- status mapping

/** Controller ruling 4: a companion waiting for Retry is never "failed". */
export function sectionViewStatus(
  s: Pick<SectionRow, "status"> & { errorClass: string | null },
): SectionViewStatus {
  if (s.status === "failed" && s.errorClass === AWAITING_RETRY_CLASS) return "waiting_retry";
  return s.status;
}

/** A failed run whose every unfinished section only waits for Retry reads "waiting for Retry". */
export function runViewStatus(
  run: Pick<RunRow, "status">,
  sections: Array<{ status: SectionViewStatus }>,
): RunViewStatus {
  if (run.status !== "failed") return run.status;
  const notDone = sections.filter((s) => s.status !== "done");
  if (notDone.length > 0 && notDone.every((s) => s.status === "waiting_retry")) return "waiting_retry";
  return "failed";
}

// ---------------------------------------------------------------- event rows

interface EventRow {
  id: number;
  symbol: string | null;
  eventDate: string;
}

function eventRow(db: Database.Database, eventId: number): EventRow | null {
  const r = db
    .prepare("SELECT id, symbol, event_date FROM calendar_events WHERE id = ?")
    .get(eventId) as { id: number; symbol: string | null; event_date: string } | undefined;
  return r ? { id: r.id, symbol: r.symbol, eventDate: r.event_date } : null;
}

function companyName(db: Database.Database, symbol: string | null): string | null {
  if (!symbol) return null;
  const r = db
    .prepare("SELECT name FROM securities WHERE UPPER(symbol) = UPPER(?) LIMIT 1")
    .get(symbol) as { name: string | null } | undefined;
  return r?.name ?? null;
}

/** Same rule as the runner's frozen list: an accepted earnings filing. */
function hasAcceptedEarnings(filings: FilingRow[]): boolean {
  return filings.some((f) => f.role === "earnings" && f.identityVerdict === "accepted");
}

/**
 * No accepted earnings filing, but an earnings-role filing whose time could
 * not be confirmed and whose document gate passed (controller rulings, Task
 * 13 rounds 2 and 3): not "no filing", and a manual run may read it (the
 * runner's owner-click rule). One whose gate failed is ambiguous instead.
 */
function earningsTimeUnconfirmedFrom(filings: FilingRow[]): boolean {
  return (
    !hasAcceptedEarnings(filings) &&
    filings.some((f) => f.role === "earnings" && f.identityVerdict === "time_unconfirmed" && f.gatePassed)
  );
}

/** The base form ("8-K" / "6-K") of the accepted, else time-unconfirmed, earnings filing. */
function earningsFormFrom(filings: FilingRow[]): "8-K" | "6-K" | null {
  const f =
    filings.find((x) => x.role === "earnings" && x.identityVerdict === "accepted") ??
    filings.find((x) => x.role === "earnings" && x.identityVerdict === "time_unconfirmed" && x.gatePassed);
  if (!f) return null;
  return f.form.toUpperCase().startsWith("6-K") ? "6-K" : "8-K";
}

/**
 * Whether `run` (Run summary) may spend for this event: an accepted earnings
 * filing (or, with none, a time-unconfirmed one), no run yet, and not
 * disarmed. The route uses the same predicate.
 */
export function runSummaryAvailable(db: Database.Database, eventId: number): boolean {
  return runSummaryAvailableFrom(
    getEventState(db, eventId)?.pollState ?? null,
    listRuns(db, eventId).length,
    listFilings(db, eventId),
  );
}

function runSummaryAvailableFrom(pollState: PollState | null, runCount: number, filings: FilingRow[]): boolean {
  return (
    pollState !== "cancelled" &&
    runCount === 0 &&
    (hasAcceptedEarnings(filings) || earningsTimeUnconfirmedFrom(filings))
  );
}

// ---------------------------------------------------------------- run assembly

interface BuiltRun {
  full: FullRun;
  summary: RunSummary;
  filingIds: Set<number>;
  /** The run has an earnings-role section whose view status is done. */
  earningsDone: boolean;
}

/** The snapshot's bogeys by key, public fields only (R15). */
function bogeysByKey(snapshotJson: string): Map<string, OperandBogey> {
  const out = new Map<string, OperandBogey>();
  for (const b of publicBogeys(snapshotJson)) {
    out.set(b.key, { label: b.label, value: b.value, unit: b.unit, provenance: b.provenance, asOf: b.asOf });
  }
  return out;
}

/** The model's own claims, by claim id, from a section's stored output. */
function modelClaimsById(outputJson: string | null): Map<string, ModelSectionOutput["bullets"][number]["claims"][number]> {
  const out = new Map<string, ModelSectionOutput["bullets"][number]["claims"][number]>();
  const parsed = parseJson<ModelSectionOutput>(outputJson);
  for (const bullet of Array.isArray(parsed?.bullets) ? parsed.bullets : []) {
    for (const claim of Array.isArray(bullet?.claims) ? bullet.claims : []) {
      if (claim && typeof claim.id === "string") out.set(claim.id, claim);
    }
  }
  return out;
}

function describeOperand(
  id: string | null,
  figures: ModelFigure[],
  bogeys: Map<string, OperandBogey>,
): OperandDescriptor | null {
  if (id === null) return null;
  const fig = figures.find((f) => f && f.id === id);
  if (!fig) return null;
  const displayText = typeof fig.valueText === "string" && fig.valueText.trim() ? fig.valueText : String(fig.value);
  if (fig.sourceKind === "bogey") {
    const bogey = fig.bogeyKey ? bogeys.get(fig.bogeyKey) : undefined;
    return bogey ? { figureId: id, displayText, source: "bogey", bogey: { ...bogey } } : { figureId: id, displayText, source: "bogey" };
  }
  return { figureId: id, displayText, source: "filing" };
}

/** Adds operand descriptors to each check; checks pair with the model's comparisons by position (evaluate.ts maps them 1:1). */
function describeComparisons(
  checks: ComparisonCheck[],
  model: ModelSectionOutput["bullets"][number]["claims"][number] | undefined,
  bogeys: Map<string, OperandBogey>,
): ViewComparisonCheck[] {
  const figures = Array.isArray(model?.figures) ? model.figures : [];
  const comparisons = Array.isArray(model?.comparisons) ? model.comparisons : [];
  return checks.map((cc, i) => {
    const cmp = comparisons[i];
    const out: ViewComparisonCheck = {
      ...cc,
      left: cmp ? describeOperand(cmp.left, figures, bogeys) : null,
      right: cmp ? describeOperand(cmp.right, figures, bogeys) : null,
    };
    const leftHigh = cmp ? describeOperand(cmp.leftHigh, figures, bogeys) : null;
    const rightHigh = cmp ? describeOperand(cmp.rightHigh, figures, bogeys) : null;
    if (leftHigh) out.leftHigh = leftHigh;
    if (rightHigh) out.rightHigh = rightHigh;
    return out;
  });
}

/** Rebuilds the link and, for an unlocated quote, attaches the model's own quote. */
function viewFootnote(f: Footnote, cik: string, accession: string, quotes: Map<string, string>): ViewFootnote {
  return {
    ...rebuildFootnote(f, cik, accession),
    modelQuote: f.status === "found" ? null : (quotes.get(f.citationId) ?? null),
  };
}

function buildSections(rows: SectionRow[], filingsById: Map<number, FilingRow>, bogeys: Map<string, OperandBogey>): FullSection[] {
  const sections: FullSection[] = rows.map((s) => {
    const filing = filingsById.get(s.filingId);
    const cik = filing?.cik ?? "";
    const accession = filing?.accession ?? "";
    const checked = s.status === "done" ? parseJson<CheckedSection>(s.checkedJson) : null;
    const models = checked ? modelClaimsById(s.outputJson) : new Map();
    const claims: ViewClaim[] = (checked?.claims ?? []).map((c) => {
      const model = models.get(c.claimId);
      const quotes = new Map<string, string>();
      for (const cit of Array.isArray(model?.citations) ? model.citations : []) {
        if (cit && typeof cit.id === "string" && typeof cit.quote === "string") quotes.set(cit.id, cit.quote);
      }
      return {
        ...c,
        footnotes: (c.footnotes ?? []).map((f) => viewFootnote(f, cik, accession, quotes)),
        comparisonChecks: describeComparisons(c.comparisonChecks ?? [], model, bogeys),
        correction: c.correction
          ? {
              ...c.correction,
              footnote: c.correction.footnote ? viewFootnote(c.correction.footnote, cik, accession, quotes) : null,
            }
          : null,
        correctedBy: null,
      };
    });
    const coverage = parseJson<CoverageEntry[]>(s.coverageJson);
    return {
      sectionId: s.id,
      seq: s.seq,
      filingId: s.filingId,
      form: filing?.form ?? "filing",
      accession,
      cik,
      acceptedAtEt: etTime(filing?.acceptedAt ?? null),
      acceptedOnEt: etDate(filing?.acceptedAt ?? null),
      status: sectionViewStatus(s),
      errorClass: s.errorClass,
      errorText: shortText(s.errorText),
      attempts: s.attempts,
      modelLabel: s.modelId ? modelLabel(s.modelId) : null,
      effort: s.effort,
      headline: checked ? checked.headline : null,
      claims,
      counts: checked ? countStatuses(claims) : null,
      coverage: Array.isArray(coverage) ? coverage : [],
      incomplete: s.incomplete,
      usage: readUsage(s.usageJson),
    };
  });

  // Hardening 14 / R17: a resolved correction marks the earlier claim.
  const byClaimId = new Map<string, ViewClaim>();
  for (const sec of sections) for (const c of sec.claims) byClaimId.set(c.claimId, c);
  for (const sec of sections) {
    for (const c of sec.claims) {
      if (!c.correction?.resolved) continue;
      const target = byClaimId.get(c.correction.claimId);
      if (target && target !== c) {
        target.correctedBy = { form: sec.form, acceptedAtEt: sec.acceptedAtEt };
      }
    }
  }
  return sections;
}

function buildRun(db: Database.Database, run: RunRow, filingsById: Map<number, FilingRow>): BuiltRun {
  const rows = listSections(db, run.id);
  const sections = buildSections(rows, filingsById, bogeysByKey(run.bogeySnapshotJson));
  const status = runViewStatus(run, sections);
  const doneClaims = sections.filter((s) => s.status === "done").flatMap((s) => s.claims);
  const counts = countStatuses(doneClaims);
  const incomplete = sections.some((s) => s.incomplete);
  const usage: Record<string, number> = {};
  for (const s of sections) {
    for (const [k, v] of Object.entries(s.usage ?? {})) usage[k] = (usage[k] ?? 0) + v;
  }
  const label = run.modelId ? modelLabel(run.modelId) : capitalise(run.family);
  const full: FullRun = {
    runId: run.id,
    runNo: run.runNo,
    status,
    trigger: run.trigger,
    family: run.family,
    effort: run.effort,
    modelLabel: label,
    fallbackNote: run.fallbackNote,
    createdAtEt: etTime(run.createdAt),
    createdOnEt: etDate(run.createdAt),
    finishedAtEt: etTime(run.finishedAt),
    counts,
    incomplete,
    excludesAfterEt: null,
    usage,
    bogeys: publicBogeys(run.bogeySnapshotJson),
    quarterLabel: quarterLabel(rows, filingsById),
    sections,
  };
  const summary: RunSummary = {
    runId: run.id,
    runNo: run.runNo,
    status,
    trigger: run.trigger,
    modelLabel: label,
    effort: run.effort,
    fallbackNote: run.fallbackNote,
    counts,
    incomplete,
    top: doneClaims.filter((c) => c.top).slice(0, 3),
    sectionStates: sections.map((s) => ({
      form: s.form,
      acceptedAtEt: s.acceptedAtEt,
      status: s.status,
      errorClass: s.errorClass,
    })),
    excludesAfterEt: null,
  };
  const earningsDone = sections.some(
    (s) => s.status === "done" && filingsById.get(s.filingId)?.role === "earnings",
  );
  return { full, summary, filingIds: new Set(sections.map((s) => s.filingId)), earningsDone };
}

/** R13: "does not include filings found after 4:10 pm" on an older run. */
function markExclusions(built: BuiltRun[], filingsById: Map<number, FilingRow>): void {
  for (let i = 0; i < built.length; i++) {
    const own = built[i].filingIds;
    const newerHasMore = built
      .slice(i + 1)
      .some((b) => [...b.filingIds].some((id) => !own.has(id)));
    if (!newerHasMore) continue;
    let latest: string | null = null;
    let latestMs = -Infinity;
    for (const id of own) {
      const d = filingsById.get(id)?.discoveredAt ?? null;
      const ms = d ? parseStoredTimestamp(d).getTime() : NaN;
      if (!Number.isNaN(ms) && ms > latestMs) {
        latestMs = ms;
        latest = d;
      }
    }
    const t = etTime(latest);
    built[i].full.excludesAfterEt = t;
    built[i].summary.excludesAfterEt = t;
  }
}

/**
 * `shown` = the newest run whose earnings section is done (a companion still
 * running, failed or waiting for Retry on that run shows through its section
 * states); the newest run when none qualifies. `inProgress` = a newer run
 * that is still running and has no done earnings section (a re-run).
 */
function pickShown(built: BuiltRun[]): { shown: BuiltRun | null; inProgress: BuiltRun | null } {
  if (built.length === 0) return { shown: null, inProgress: null };
  const newestFirst = [...built].reverse();
  const shown = newestFirst.find((b) => b.earningsDone) ?? built[built.length - 1];
  const inProgress =
    newestFirst.find(
      (b) => b.full.runNo > shown.full.runNo && !b.earningsDone && b.full.status === "running",
    ) ?? null;
  return { shown, inProgress };
}

/** "Q3" when one run's earnings section's quoted actual-quarter figures name one quarter. */
function quarterLabel(rows: SectionRow[], filingsById: Map<number, FilingRow>): string | null {
  const counts = new Map<number, number>();
  for (const s of rows) {
    if (s.status !== "done" || filingsById.get(s.filingId)?.role !== "earnings") continue;
    const out = parseJson<{ bullets?: Array<{ claims?: Array<{ figures?: unknown[] }> }> }>(s.outputJson);
    for (const bullet of out?.bullets ?? []) {
      for (const claim of bullet.claims ?? []) {
        for (const fig of claim.figures ?? []) {
          const f = fig as { sourceKind?: unknown; period?: { kind?: unknown; role?: unknown; fiscalQuarter?: unknown } };
          const q = f.period?.fiscalQuarter;
          if (
            f.sourceKind === "quote" && f.period?.kind === "quarter" && f.period.role === "actual" &&
            typeof q === "number" && Number.isInteger(q) && q >= 1 && q <= 4
          ) {
            counts.set(q, (counts.get(q) ?? 0) + 1);
          }
        }
      }
    }
  }
  let best: number | null = null;
  let bestN = 0;
  let tie = false;
  for (const [q, n] of counts) {
    if (n > bestN) {
      best = q;
      bestN = n;
      tie = false;
    } else if (n === bestN) {
      tie = true;
    }
  }
  return best !== null && !tie ? `Q${best}` : null;
}

function buildAll(db: Database.Database, eventId: number) {
  const filings = listFilings(db, eventId);
  const filingsById = new Map(filings.map((f) => [f.id, f]));
  const built = listRuns(db, eventId).map((r) => buildRun(db, r, filingsById));
  markExclusions(built, filingsById);
  return { filings, filingsById, built, ...pickShown(built) };
}

// ---------------------------------------------------------------- public API

function choiceOptions(catalogIds: string[]): ChoiceOption[] {
  return SUMMARY_CHOICES.map((c) => ({
    choice: { ...c },
    value: choiceValue(c),
    label: choiceLabel(c),
    nowLabel: familyNowLabel(c.family, catalogIds),
  }));
}

/** The running run's running (else first pending) section, with its fetched exhibit count. */
function readingDocsFor(db: Database.Database, candidates: Array<BuiltRun | null>): ReadingDocs | null {
  const run = candidates.find((b) => b && b.full.status === "running") ?? null;
  if (!run) return null;
  const sections = run.full.sections;
  const section = sections.find((s) => s.status === "running") ?? sections.find((s) => s.status === "pending");
  if (!section) return null;
  const exhibits = listDocuments(db, section.filingId).filter(
    (d) => d.status === "fetched" && d.docType.toUpperCase().startsWith("EX-"),
  ).length;
  return { form: section.form, exhibits };
}

function panelFor(db: Database.Database, eventId: number, catalogIds: string[]): PanelView {
  const { choice, isDefault, locked } = getChoice(db, eventId);
  const state = getEventState(db, eventId);
  const { filings, built, shown, inProgress } = buildAll(db, eventId);
  return {
    eventId,
    readingDocs: readingDocsFor(db, [inProgress, shown]),
    choiceOptions: choiceOptions(catalogIds),
    choice,
    choiceLabel: choiceLabel(choice),
    isDefault,
    locked,
    nowLabel: familyNowLabel(choice.family, catalogIds),
    pollState: state?.pollState ?? null,
    pollDetail: state?.pollDetail ?? null,
    shown: shown?.summary ?? null,
    inProgress: inProgress?.summary ?? null,
    runSummaryAvailable: runSummaryAvailableFrom(state?.pollState ?? null, built.length, filings),
    earningsTimeUnconfirmed: earningsTimeUnconfirmedFrom(filings),
    earningsForm: earningsFormFrom(filings),
  };
}

/** Panel views for the given events; ids with no calendar row are left out. */
export function getPanelViews(
  db: Database.Database,
  eventIds: number[],
  catalogIds: string[],
): Record<number, PanelView> {
  const out: Record<number, PanelView> = {};
  for (const id of eventIds) {
    if (!eventRow(db, id)) continue;
    out[id] = panelFor(db, id, catalogIds);
  }
  return out;
}

/** The full summary page's data; null when the event does not exist. */
export function getFullView(db: Database.Database, eventId: number, catalogIds: string[]): FullView | null {
  const ev = eventRow(db, eventId);
  if (!ev) return null;
  const { choice, isDefault, locked } = getChoice(db, eventId);
  const state = getEventState(db, eventId);
  const { filings, built, shown, inProgress } = buildAll(db, eventId);
  return {
    event: {
      eventId,
      symbol: ev.symbol,
      companyName: companyName(db, ev.symbol),
      eventDate: ev.eventDate,
      quarterLabel: shown?.full.quarterLabel ?? null,
      pollState: state?.pollState ?? null,
      pollDetail: state?.pollDetail ?? null,
    },
    choice: {
      current: choice,
      label: choiceLabel(choice),
      isDefault,
      locked,
      nowLabel: familyNowLabel(choice.family, catalogIds),
      options: choiceOptions(catalogIds),
    },
    runSummaryAvailable: runSummaryAvailableFrom(state?.pollState ?? null, built.length, filings),
    shownRunId: shown?.full.runId ?? null,
    inProgressRunId: inProgress?.full.runId ?? null,
    runs: built.map((b) => b.full),
    filings: filings.map((f) => ({
      filingId: f.id,
      accession: f.accession,
      cik: f.cik,
      form: f.form,
      role: f.role,
      acceptedAtEt: etTime(f.acceptedAt),
      acceptedOnEt: etDate(f.acceptedAt),
      discoveredAtEt: etTime(f.discoveredAt),
      identityVerdict: f.identityVerdict,
      identityReason: f.identityReason,
      fetchState: f.fetchState,
      indexUrl: filingIndexUrl(f.cik, f.accession),
      documents: listDocuments(db, f.id).map((d) => ({
        fileName: d.fileName,
        docType: d.docType,
        status: d.status,
        skipReason: d.skipReason,
        url: safeArchiveUrl(f.cik, f.accession, d.fileName),
      })),
    })),
  };
}
