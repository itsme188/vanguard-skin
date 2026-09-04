/**
 * The print sheet's pure helpers — moved out of `PrintWatchPanel.tsx` (slice F,
 * task 8) so the panel's body can become the Hub's per-row expansion.
 *
 * Everything here is VERBATIM from the panel except `presentState`, which gains
 * the `retired` case (M-F17): slice F's `recompileContracts` is the first
 * producer of that state, and before this the switch fell through to "pending",
 * which read as "still coming" for a line that is history.
 *
 * NOT a `"use client"` module — it holds no JSX and no hooks — but every
 * importer of it IS a client file, so it may reach for nothing the browser
 * bundle cannot take: `@/lib/print-watch/{types,reconcile}` (both on the
 * client-safe allowlist), `@/lib/format`, and the `ChipTone` type. That is the
 * exact set the panel imported.
 *
 * Privacy note carried over from the panel: the bogey column is the desk's OWN
 * curated consensus/whisper — portfolio-derived — so it renders through
 * `<PrivateText>`, and so does the Δ computed against it (M-F19). The reported
 * actual is public press-release data and renders plain.
 */

import { reconcile } from "@/lib/print-watch/reconcile";
import { formatLargeUSD, formatPercent } from "@/lib/format";
import type { ChipTone } from "../../components/Chip";
import type { GoRequestWire } from "../hub-live/types";
import type {
  ExpectedValue,
  LineContract,
  PrintWatchLine,
  PrintWatchState,
  TaggedCandidate,
} from "@/lib/print-watch/types";

/** The drop route's 200 outcomes — a document can be parsed, rejected as the
 *  wrong issuer/period, already in hand, parked behind another lease, refused
 *  as unreadable, or stored-but-unparsed. */
export type DropOutcome = "parsed" | "rejected" | "duplicate" | "queued" | "refused" | "parse_failed";

/**
 * Standing disclosure under the panel header (fix wave, finding G). v1 is a
 * PRE-GATE build: every number on this sheet was read out of a document by a
 * model minutes ago, and the desk is about to trade on it. The one line that
 * has to be true on every render is that nothing here has been checked by a
 * human yet.
 */
export const PRE_GATE_DISCLOSURE =
  "Pre-gate build — machine-read values; verify every number before accepting.";

/**
 * The promote confirm for a 409 `superseded` (fix wave, finding B). Kept
 * distinct from the pre-print confirm on purpose: one asks "the release hasn't
 * happened yet, sure?", this one asks "the number you accepted has since been
 * contradicted, sure?" — and answering one must never be read as answering the
 * other.
 */
export const SUPERSEDED_CONFIRM_COPY =
  "Newer evidence disagrees with the accepted number — re-verify before promoting. Promote the accepted value anyway?";

/**
 * The ACCEPT-side twin (Codex HIGH). The route now runs the same supersession
 * comparison when the desk re-accepts an un-accepted line whose number is
 * residue, so this confirm can reach a click that said "accept", never
 * "promote" — and a dialog that asks about promoting a value the user was not
 * promoting is a misleading affordance, not a shortcut.
 */
export const SUPERSEDED_ACCEPT_CONFIRM_COPY =
  "Newer evidence disagrees with the number left on this line — re-verify before accepting. Accept it as it stands anyway?";

/**
 * The PER-CANDIDATE twin. Accepting a named document's figure can only be
 * refused for one reason — a LATER document disagrees with the one picked — so
 * the confirm has to ask about that, not about "the number left on this line"
 * (there is none on a conflict row) and not about promoting.
 */
export const SUPERSEDED_CANDIDATE_CONFIRM_COPY =
  "A later document disagrees with the figure you picked — re-verify before accepting. Lock in the figure you chose anyway?";

export const HOT_STATES: ReadonlySet<PrintWatchState> = new Set(["window_open", "acquired"]);
export const HOT_POLL_MS = 2_000;
export const COOL_POLL_MS = 30_000;
export const ENSURE_INTERVAL_MS = 60_000;

// ── pure helpers (TDD'd in tests/dashboard/print-watch-panel.test.ts) ──

/** Canonical source-ladder ordering — matches the watcher's status keys
 *  (lib/print-watch/watcher.ts: watcher/dj/edgar/rss/gate/pipeline/flash/
 *  loop). Unknown keys (future sources, or a coverage note under an
 *  unexpected key) are appended alphabetically rather than dropped. */
const LADDER_ORDER = ["watcher", "dj", "edgar", "rss", "ir", "gate", "pipeline", "flash", "loop"] as const;
const LADDER_LABELS: Record<string, string> = {
  watcher: "Watcher",
  dj: "DJ",
  edgar: "EDGAR",
  rss: "RSS",
  ir: "IR",
  gate: "Gate",
  pipeline: "Pipeline",
  flash: "Flash",
  loop: "Loop",
};

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Renders the per-source status line ("DJ: ok — 1 release(s) · EDGAR: CIK
 *  unresolved · …"). Empty object → "" — the panel renders its own
 *  "awaiting first poll" copy for that case (a server restart clears
 *  in-memory sources/coverage until the watcher's next tick). */
export function ladderText(sources: Record<string, string>): string {
  const keys = Object.keys(sources);
  if (keys.length === 0) return "";
  const known = LADDER_ORDER.filter((k) => k in sources);
  const unknown = keys.filter((k) => !(LADDER_ORDER as readonly string[]).includes(k)).sort();
  return [...known, ...unknown]
    .map((k) => `${LADDER_LABELS[k] ?? capitalize(k)}: ${sources[k]}`)
    .join(" · ");
}

const ROAD_LABELS: Record<string, string> = { "user-url": "link", "user-drop": "file", dj: "DJ", edgar: "EDGAR", ir: "IR" };

/** One line for the go request's state — plain outcomes, no figures. */
export function goStatusText(go: GoRequestWire | null): string | null {
  if (!go) return null;
  if (go.status === "queued") return "Print is live — queued, waking the watcher…";
  if (go.status === "claimed") return `Print is live — acquiring (attempt ${go.attempts})…`;
  const roads = (go.result ?? []).map((r) => {
    const label = ROAD_LABELS[r.road] ?? r.road;
    return r.outcome === "ok" ? `${label}: ok` : `${label}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}`;
  });
  if (go.status === "failed") {
    const why = (go.result ?? []).find((r) => r.outcome === "failed")?.detail ?? "no detail";
    return `Print is live — FAILED after ${go.attempts} attempt(s): ${why}`;
  }
  return `Print is live — ${roads.join(" · ")}`;
}

export function etClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
}

/** The effective window in desk language (public timing, not portfolio data). */
export function windowText(w: { start: string; end: string } | null, nowMs: number): string {
  if (!w) return "no auto window — drop zone only";
  if (nowMs < Date.parse(w.start)) return `window opens ${etClock(w.start)}`;
  if (nowMs <= Date.parse(w.end)) return `window open until ${etClock(w.end)}`;
  return `window closed ${etClock(w.end)}`;
}

export interface DeltaResult {
  label: string;
  sign: 1 | -1 | 0;
}

/** Plain sign+percent delta of actual vs. bogey — same "in-line" epsilon
 *  and formatting convention as EarningsHub's epsDelta. null when either
 *  side is missing, or the bogey is exactly zero (undefined percent
 *  base). */
export function deltaPct(expected: number | null, actual: number | null): DeltaResult | null {
  if (expected === null || actual === null) return null;
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return null;
  if (expected === 0) return null;
  const pct = ((actual - expected) / Math.abs(expected)) * 100;
  const sign: 1 | -1 | 0 = Math.abs(pct) < 0.05 ? 0 : pct > 0 ? 1 : -1;
  if (sign === 0) return { label: "in-line", sign };
  return { label: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`, sign };
}

/**
 * The print-state chip's TEXT (never colour alone).
 *
 * `expired` is the one state whose raw name lies to the desk: it reads like
 * the print is over and there is nothing left to do, when what actually
 * happened is that the automatic window closed without the wire delivering —
 * the moment the manual drop matters MOST. "window closed" says that, and the
 * card keeps its drop zone live behind it (an expired print still ingests:
 * `getPrintByEventId` has no state filter and `advanceState` only refuses
 * `disarmed`).
 */
export function printStateLabel(state: PrintWatchState): { text: string; tone: ChipTone } {
  switch (state) {
    case "expired":
      return { text: "window closed", tone: "warn" };
    case "window_open":
    case "acquired":
      return { text: state.replace("_", " "), tone: "gold" };
    case "parsed":
      return { text: "parsed", tone: "up" };
    default:
      return { text: state.replace("_", " "), tone: "neutral" };
  }
}

/**
 * The header's count line. `expired` prints are listed alongside active ones
 * (their drop zone is still live), so counting the whole list as "active"
 * puts "2 active prints" above two chips both reading WINDOW CLOSED. Closed
 * prints are counted separately and only mentioned when some exist.
 */
export function printCountLabel(prints: ReadonlyArray<{ state: PrintWatchState }>): string {
  const closed = prints.filter((p) => p.state === "expired").length;
  const active = prints.length - closed;
  const plural = (n: number) => (n === 1 ? "print" : "prints");
  if (closed === 0) return `${active} active ${plural(active)}`;
  if (active === 0) return `${closed} closed ${plural(closed)}`;
  return `${active} active · ${closed} closed`;
}

/** Names the SOURCE behind one conflicting candidate: "doc #12 (edgar-ex99 ·
 *  repA)". Doc id alone ("doc #12 vs doc #13") tells the desk nothing about
 *  which rival number to believe; the kind is the whole decision. Flash
 *  candidates have no document of record (sentinel doc id 0) and say so. */
export function candidateSourceLabel(
  candidate: Pick<TaggedCandidate, "doc_id" | "representation">,
  documents: Record<number, string> | undefined,
): string {
  if (candidate.representation === "flash") return "wire flash";
  const kind = documents?.[candidate.doc_id];
  const detail = kind ? `${kind} · ${candidate.representation}` : candidate.representation;
  return `doc #${candidate.doc_id} (${detail})`;
}

export interface DropOutcomeMessage {
  tone: "note" | "error";
  text: string;
}

/** What to tell the desk after a drop returns. The old copy said "parsing
 *  now" for every 200 and never cleared — a rejected document (wrong issuer /
 *  wrong period), a re-drop of bytes already in hand, and a document parked
 *  behind another process's lease all sat there looking like work in progress
 *  that would never finish. */
export function dropOutcomeMessage(
  outcome: DropOutcome | undefined,
  rejectReason: string | null | undefined,
): DropOutcomeMessage {
  if (outcome === "rejected") {
    return {
      tone: "error",
      text: `Rejected: ${rejectReason ?? "the document didn't name this issuer and period"}`,
    };
  }
  if (outcome === "duplicate") {
    return { tone: "note", text: "Already ingested — no new evidence." };
  }
  if (outcome === "queued") {
    return {
      tone: "note",
      text: "Queued — another process owns the watch; it will parse shortly.",
    };
  }
  // Task 10: a REFUSAL is about the file itself — nothing was stored, so the
  // desk has to hand over a different file (or a link) rather than wait.
  if (outcome === "refused") {
    return {
      tone: "error",
      text: `Not readable: ${rejectReason ?? "print-watch reads HTML, plain text, or PDF"}. Drop an HTML, text or PDF release, or paste its link.`,
    };
  }
  // The document IS stored and eligible; the read attempt failed. Saying
  // "parsed" here would claim a sheet update that never happened.
  if (outcome === "parse_failed") {
    return {
      tone: "error",
      text: `Stored, but the read failed — it will retry. ${rejectReason ?? "the parse did not complete"}`,
    };
  }
  return { tone: "note", text: "Parsed — sheet updated." };
}

/** First file off a drag-drop payload, or null when the drag carried no file
 *  (a dragged link, selected text, an empty drop). Pure so the drop wiring
 *  can be tested without a DOM. */
export function firstDroppedFile(
  transfer: { files?: ArrayLike<File> | null } | null | undefined,
): File | null {
  const files = transfer?.files;
  if (!files || files.length === 0) return null;
  return files[0] ?? null;
}

/** EPS-scale dollar formatting ("$0.91" / "-$0.12") — formatLargeUSD's
 *  sub-$1k branch already does this, but promoteSummary's label wants the
 *  sign OUTSIDE the "$" explicitly spelled out here to stay independent of
 *  formatLargeUSD's exact thresholds. */
function formatEpsValue(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export interface PromoteSummary {
  epsMetricId: "eps_adj_q" | "eps_gaap_q";
  epsValue: number;
  basisLabel: "adj" | "gaap";
  revenueValue: number;
  label: string;
}

/** null unless there is a COMPLETE, accepted headline pair: an accepted
 *  EPS line (adjusted preferred, GAAP as fallback) AND an accepted
 *  revenue_q line, both with a concrete value. Mirrors the accept route's
 *  own pair rule (task-11 brief) — the UI must refuse the same partial
 *  promote the server would 400 on, so the button's disabled state never
 *  lies. */
export function promoteSummary(lines: PrintWatchLine[]): PromoteSummary | null {
  const byId = new Map(lines.map((l) => [l.metric_id, l]));
  const adj = byId.get("eps_adj_q");
  const gaap = byId.get("eps_gaap_q");
  const revenue = byId.get("revenue_q");

  const acceptedWithValue = (l: PrintWatchLine | undefined): l is PrintWatchLine =>
    !!l && l.state === "accepted" && l.value !== null;

  const epsLine = acceptedWithValue(adj) ? adj : acceptedWithValue(gaap) ? gaap : null;
  if (!epsLine) return null;
  if (!acceptedWithValue(revenue)) return null;

  const basisLabel: "adj" | "gaap" = epsLine.metric_id === "eps_adj_q" ? "adj" : "gaap";
  const epsValue = epsLine.value as number;
  const revenueValue = revenue.value as number;
  const label = `Promote EPS+Rev (${basisLabel} ${formatEpsValue(epsValue)} · ${formatLargeUSD(revenueValue)})`;

  return {
    epsMetricId: epsLine.metric_id as "eps_adj_q" | "eps_gaap_q",
    epsValue,
    basisLabel,
    revenueValue,
    label,
  };
}

/** Component-wise divergence check shared by value and value_high: null on
 *  both sides is agreement (point-kind lines never carry a high end),
 *  null on exactly one side is a divergence in its own right (a range
 *  gaining or losing its top end is a real change), otherwise the same
 *  relative tolerance used everywhere else in the reconciler. */
function valuesDiverge(accepted: number | null, fresh: number | null): boolean {
  if (accepted === null && fresh === null) return false;
  if (accepted === null || fresh === null) return true;
  const tolerance = Math.max(1e-9, Math.abs(accepted) * 1e-6);
  return Math.abs(accepted - fresh) > tolerance;
}

/**
 * True when an ACCEPTED line's locked value has been superseded by fresh
 * evidence in its (continuously-refreshed) candidates_json — the
 * "superseded — re-verify" chip. Two independent triggers (fix round 2 —
 * a real correction case had zero signal under trigger (a) alone):
 *
 * (a) A fresh independent recompute — reusing the production reconciler
 *     (lib/print-watch/reconcile.ts) over just this line's own candidate
 *     pool with an empty acceptedLines set, so "independent agreement"
 *     means exactly what it means everywhere else in the system — lands
 *     on 'agreed' at a value (or value_high) that diverges from the
 *     locked one. Covers flash-then-agreed: two independent non-flash
 *     sources land after acceptance and confirm a DIFFERENT number.
 *
 * (b) ANY non-flash candidate in candidates_json carries a value (or
 *     value_high) that diverges from the accepted number, regardless of
 *     what the fresh recompute lands on. This is the realistic
 *     correction case (an 8-K/A, a corrected user drop): evidence is
 *     NEVER removed, so a correcting candidate lands alongside the
 *     original agreeing ones, and the reconciler's strict-unanimity rule
 *     means that pool can only ever resolve to 'conflict' from then on —
 *     trigger (a) can structurally never fire again for it, even though
 *     real, non-flash evidence now disagrees with what's on the sheet.
 *     Flash candidates are excluded from (b) on purpose: wire-flash
 *     rounding disagreeing with the eventual print number is expected
 *     noise, not a correction signal.
 *
 * Both triggers compare value AND value_high independently (range-kind
 * guidance lines can have their top revised while the floor holds, or
 * vice versa).
 */
export function needsReverify(line: PrintWatchLine): boolean {
  if (line.state !== "accepted" || line.value === null) return false;
  let candidates: TaggedCandidate[];
  try {
    const parsed = JSON.parse(line.candidates_json) as unknown;
    if (!Array.isArray(parsed)) return false;
    candidates = parsed as TaggedCandidate[];
  } catch {
    return false;
  }
  if (candidates.length === 0) return false;

  // Trigger (a): a fresh independent agreement diverging from the locked
  // value.
  const expectedMap: Record<string, ExpectedValue> = {};
  const [fresh] = reconcile([line.contract], expectedMap, candidates, []);
  if (fresh && fresh.state === "agreed" && fresh.value !== null) {
    if (
      valuesDiverge(line.value, fresh.value) ||
      valuesDiverge(line.value_high, fresh.value_high)
    ) {
      return true;
    }
  }

  // Trigger (b): any single non-flash candidate that conflicts with the
  // locked value — the correction case (a) structurally cannot catch.
  //
  // Document-order aware (defect fix, parity with the accept route's
  // `divergentCandidates`): a per-candidate accept sets `source_doc_id` to
  // the chosen document and deliberately leaves the rejected rival in
  // `candidates_json`, so without this check the chip mislabeled a
  // just-verified line "superseded" on evidence the desk had already
  // out-verified by picking the newer document. Only a candidate from a
  // STRICTLY LATER document counts as later evidence.
  for (const c of candidates) {
    if (c.representation === "flash") continue;
    if (c.not_disclosed || c.value === null) continue;
    if (typeof line.source_doc_id === "number" && c.doc_id <= line.source_doc_id) continue;
    if (valuesDiverge(line.value, c.value) || valuesDiverge(line.value_high, c.value_high)) {
      return true;
    }
  }

  return false;
}

/**
 * True when the panel should offer a per-line "accept" control on this line.
 *
 * The recovery path out of an un-accept (QA finding
 * `today-print-watch--unaccept-one-way-no-per-line-accept-promote-falls-to-gaap`):
 * an un-accepted line with no candidate evidence to re-derive from parks on
 * 'pending' while KEEPING its verified number, and the only other control that
 * accepts anything is the bulk "Accept all agreed" button — which takes
 * 'agreed' lines only. So an accidental un-accept was one-way until the watcher
 * happened to reconcile that line again (and once the watch window closes it
 * never does): the desk could watch a correct, still-rendered number sit on
 * the sheet with no way to put it back, while Promote silently fell through
 * to the GAAP basis.
 *
 * A line that DID re-derive lands on a real reconciler state and is covered by
 * the rule below — except 'conflict', whose rivals get their own per-candidate
 * controls (`acceptableRivals`).
 *
 * The rule mirrors the accept route's own state guard, minus the states that
 * have no number to accept:
 *   - 'accepted'  → false — the unaccept control renders instead.
 *   - 'conflict'  → false — needs resolving, and the route refuses it too.
 *   - value null  → false — nothing to lock in: a bare 'pending' line still
 *                   waiting for a source, or a 'blank' ("not disclosed")
 *                   line, which the route does allow but which carries no
 *                   figure this control could promise.
 *   - otherwise   → true — 'agreed', plus the eyes-on overrides the route
 *                   already permits ('single_source', 'flash') and the
 *                   un-accepted 'pending'-with-a-value case above.
 */
export function canAcceptLine(line: PrintWatchLine): boolean {
  if (line.state === "accepted") return false;
  if (line.state === "conflict") return false;
  return line.value !== null;
}

/** Stable identity of one candidate inside a line's pool — the document, the
 *  reading of it, and the figure. Two entries with the same key are the same
 *  piece of evidence recorded twice, and must not become two buttons. */
export function candidateKey(c: TaggedCandidate): string {
  return `${c.doc_id}|${c.representation}|${c.value}|${c.value_high}`;
}

/**
 * The rival figures a CONFLICT row offers a per-candidate "accept this"
 * control for (QA finding `today-print-watch--unaccept-after-supersede-keeps-
 * old-value-hides-newer-candidate`, user ruling 2026-09-02).
 *
 * A conflict line carries no top-level number — the reconciler refuses to pick
 * between disagreeing documents, and `canAcceptLine` refuses it for the same
 * reason. Since un-accepting a superseded line now re-derives it into exactly
 * this state, "no control at all" would leave the desk with nowhere to go on a
 * corrected print. So the resolution is the honest one: accept the figure from
 * the document you read, by name.
 *
 * Excluded, all for the same reason the route refuses them:
 *   - flash — a wire flash has no document of record (`source_doc_id` is a real
 *     FK), and it is expected to round differently from the eventual document.
 *   - not_disclosed / value null — no figure to lock in.
 * Non-conflict lines return nothing: their state IS the reconciler's current
 * reading, and the line-level accept control already covers them.
 */
export function acceptableRivals(line: PrintWatchLine): TaggedCandidate[] {
  if (line.state !== "conflict") return [];
  let candidates: TaggedCandidate[];
  try {
    const parsed = JSON.parse(line.candidates_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    candidates = parsed as TaggedCandidate[];
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const rivals: TaggedCandidate[] = [];
  for (const c of candidates) {
    if (c.representation === "flash") continue;
    if (c.not_disclosed || c.value === null) continue;
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    rivals.push(c);
  }
  return rivals;
}

// ── state chip presentation (text + icon — never color alone) ─────────

export interface ChipPresentation {
  text: string;
  icon: string;
  tone: ChipTone;
}

export function presentState(line: PrintWatchLine): ChipPresentation {
  if (line.state === "accepted") {
    return needsReverify(line)
      ? { text: "superseded — re-verify", icon: "⟳", tone: "down" }
      : { text: "accepted", icon: "✓✓", tone: "up" };
  }
  switch (line.state) {
    case "agreed":
      return { text: "agreed — verify", icon: "✓", tone: "up" };
    case "single_source":
      return { text: "single source — verify", icon: "◐", tone: "warn" };
    case "conflict":
      return { text: "conflict", icon: "⚠", tone: "down" };
    case "flash":
      return { text: "wire flash", icon: "⚡", tone: "gold" };
    case "blank":
      return { text: "not disclosed", icon: "—", tone: "neutral" };
    // Slice F (M-F17): recompileContracts renames a superseded definition's
    // row to <metric_id>~retired~<n> and books it 'retired'. It is history,
    // not a measurement in progress — before slice F it fell through to
    // "pending", which read as "still coming".
    case "retired":
      return { text: "retired — definition changed", icon: "⌀", tone: "neutral" };
    case "pending":
    default:
      return { text: "pending", icon: "⋯", tone: "neutral" };
  }
}

export function formatContractValue(contract: LineContract, value: number | null): string {
  if (value === null) return "—";
  switch (contract.unit) {
    case "per_share":
      return formatEpsValue(value);
    case "usd":
      return formatLargeUSD(value);
    case "percent":
      return formatPercent(value, 1);
    case "count":
    default:
      return value.toLocaleString("en-US");
  }
}

/** Range-kind contracts (guidance: revenue_guide_next / eps_adj_guide_next)
 *  carry a value_high alongside value — render "low–high" so a guidance
 *  range doesn't silently collapse to just its floor. Point-kind contracts
 *  (value_high always null) render unchanged. */
export function formatContractRange(
  contract: LineContract,
  value: number | null,
  valueHigh: number | null,
): string {
  if (value === null) return "—";
  const lo = formatContractValue(contract, value);
  if (valueHigh === null) return lo;
  return `${lo}–${formatContractValue(contract, valueHigh)}`;
}

export function basisNote(contract: LineContract): string | null {
  if (contract.basis === "gaap") return "GAAP";
  if (contract.basis === "non_gaap") return "adj";
  return null;
}

// ── file → base64, for the drop zone ───────────────────────────────────

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Could not read the file."));
        return;
      }
      // "data:<mime>;base64,AAAA…" — the route wants the payload only.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("File read failed."));
    reader.readAsDataURL(file);
  });
}
