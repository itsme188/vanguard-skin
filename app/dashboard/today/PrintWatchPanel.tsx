"use client";

/**
 * Live Print Watch — Today-tab surface for the print-watch v1 subsystem
 * (docs/superpowers/specs/2026-08-20-live-print-watch-design.md, plan Task
 * 12). Polls GET /api/print-watch/status for the live sheet, keeps the
 * in-process watcher alive with a periodic POST /ensure, and lets the desk
 * drag-drop a release / accept agreed lines / promote the verified
 * headline pair into the earnings recap scoreboard.
 *
 * Visual precedent: EarningsHub.tsx (mono uppercase header, Chip, tokens).
 *
 * Privacy: the bogey column is the user's OWN curated consensus/whisper —
 * portfolio-derived — so it renders through <PrivateText>. The actual
 * (reported) column is public press-release data and renders plain, same
 * as EarningsHub's NumCell.
 */

import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import apiFetch from "@/lib/http/apiFetch";
import { Chip, type ChipTone } from "../components/Chip";
import { EmptySection } from "../components/EmptySection";
import { PrivateText } from "@/lib/privacy/components";
import { formatLargeUSD, formatPercent } from "@/lib/format";
import { reconcile } from "@/lib/print-watch/reconcile";
import type {
  ExpectedValue,
  LineContract,
  PrintWatchLine,
  PrintWatchState,
  TaggedCandidate,
} from "@/lib/print-watch/types";

// ── wire shape from GET /api/print-watch/status ────────────────────────
//
// Contract (Task 10, built in parallel — not this task's file):
//   {success:true, data:{prints:[{printId, symbol, state, sources,
//   coverage, lines}]}}.
//
// `eventId` was originally missing end-to-end (getWatchStatus dropped it
// from PrintRow before the status route could forward it) — that server
// gap has since been fixed (WatchStatusRow now carries eventId through to
// the route). `eventId` stays OPTIONAL on this client-side type anyway as
// harmless defense-in-depth: every mutating control below still degrades
// honestly (disabled, with an explanatory title) rather than crashing or
// guessing an id if a future server change ever drops it again.
interface PrintStatusEntry {
  printId: number;
  eventId?: number;
  symbol: string;
  state: PrintWatchState;
  sources: Record<string, string>;
  coverage: string[];
  lines: PrintWatchLine[];
  /** doc id → document kind ("edgar-ex99" / "dj-release" / "user-drop" /
   *  "ir-page"), so a conflict row can name WHICH source each rival number
   *  came from. Optional: a server that predates the map degrades to the
   *  bare "doc #N" label rather than crashing. */
  documents?: Record<number, string>;
}

interface StatusResponse {
  success?: boolean;
  data?: { prints: PrintStatusEntry[] };
  error?: string;
}

interface EnsureResponse {
  success?: boolean;
  data?: { prints: number };
  error?: string;
}

interface AcceptResponse {
  success?: boolean;
  error?: string;
  code?: string;
}

interface DropResponse {
  success?: boolean;
  data?: {
    docId: number;
    isNew: boolean;
    outcome?: "parsed" | "rejected" | "duplicate";
    rejectReason?: string | null;
  };
  error?: string;
}

const HOT_STATES: ReadonlySet<PrintWatchState> = new Set(["window_open", "acquired"]);
const HOT_POLL_MS = 2_000;
const COOL_POLL_MS = 30_000;
const ENSURE_INTERVAL_MS = 60_000;

// ── pure helpers (TDD'd in tests/dashboard/print-watch-panel.test.ts) ──

/** Canonical source-ladder ordering — matches the watcher's status keys
 *  (lib/print-watch/watcher.ts: watcher/dj/edgar/rss/gate/pipeline/flash/
 *  loop). Unknown keys (future sources, or a coverage note under an
 *  unexpected key) are appended alphabetically rather than dropped. */
const LADDER_ORDER = ["watcher", "dj", "edgar", "rss", "gate", "pipeline", "flash", "loop"] as const;
const LADDER_LABELS: Record<string, string> = {
  watcher: "Watcher",
  dj: "DJ",
  edgar: "EDGAR",
  rss: "RSS",
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

interface DeltaResult {
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
 *  wrong period) and a re-drop of bytes already in hand both sat there looking
 *  like work in progress that would never finish. */
export function dropOutcomeMessage(
  outcome: "parsed" | "rejected" | "duplicate" | undefined,
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
  for (const c of candidates) {
    if (c.representation === "flash") continue;
    if (c.not_disclosed || c.value === null) continue;
    if (valuesDiverge(line.value, c.value) || valuesDiverge(line.value_high, c.value_high)) {
      return true;
    }
  }

  return false;
}

// ── state chip presentation (text + icon — never color alone) ─────────

interface ChipPresentation {
  text: string;
  icon: string;
  tone: ChipTone;
}

function presentState(line: PrintWatchLine): ChipPresentation {
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
    case "pending":
    default:
      return { text: "pending", icon: "⋯", tone: "neutral" };
  }
}

function formatContractValue(contract: LineContract, value: number | null): string {
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
function formatContractRange(
  contract: LineContract,
  value: number | null,
  valueHigh: number | null,
): string {
  if (value === null) return "—";
  const lo = formatContractValue(contract, value);
  if (valueHigh === null) return lo;
  return `${lo}–${formatContractValue(contract, valueHigh)}`;
}

function basisNote(contract: LineContract): string | null {
  if (contract.basis === "gaap") return "GAAP";
  if (contract.basis === "non_gaap") return "adj";
  return null;
}

// ── file → base64, for the drop zone ───────────────────────────────────

function fileToBase64(file: File): Promise<string> {
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

// ── component ────────────────────────────────────────────────────────

export default function PrintWatchPanel() {
  const [prints, setPrints] = useState<PrintStatusEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  // Mirrors `prints` for the poll scheduler so it reads live state without
  // needing `prints` in its own dependency array (useCallback render-loop
  // pattern — see memory/feedback_usecallback_pattern.md).
  const printsRef = useRef<PrintStatusEntry[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await apiFetch("/api/print-watch/status");
      const data = (await res.json().catch(() => null)) as StatusResponse | null;
      if (!res.ok || !data?.success || !data.data) {
        setStatusError(data?.error ?? `Server returned ${res.status}`);
        return;
      }
      setStatusError(null);
      setPrints(data.data.prints);
      printsRef.current = data.data.prints;
    } catch {
      setStatusError("Could not reach the server for print-watch status.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const ensureWatcher = useCallback(async () => {
    try {
      const res = await apiFetch("/api/print-watch/ensure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json().catch(() => null)) as EnsureResponse | null;
      // Non-blocking by design: /ensure only arms the watcher loops, it
      // never changes what the panel shows, and the 60s timer retries on
      // its own — so a failure here never becomes a user-facing error.
      // But a SILENTLY, persistently failing /ensure (e.g. a stale
      // session/CSRF cookie) would otherwise give zero signal that the
      // watcher has stopped being kept alive, so surface it to the
      // console rather than swallowing it outright.
      if (!res.ok || !data?.success) {
        console.warn(
          `print-watch: /ensure failed (${data?.error ?? `server returned ${res.status}`})`,
        );
      }
    } catch (err) {
      console.warn(
        `print-watch: /ensure request failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  // Recursive setTimeout (never setInterval, to avoid overlap) — cadence
  // is 2s while any print is window_open/acquired, else 30s, and the
  // status timer stops entirely once there is nothing active. The 60s
  // /ensure timer (below) still runs unconditionally and re-triggers a
  // fresh status fetch + reschedule after each tick, so a print that gets
  // armed while the desk is watching an otherwise-quiet panel is picked
  // up within one ensure cycle rather than requiring a reload.
  const scheduleNextPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    const active = printsRef.current;
    if (active.length === 0) return;
    const hot = active.some((p) => HOT_STATES.has(p.state));
    const delay = hot ? HOT_POLL_MS : COOL_POLL_MS;
    pollTimerRef.current = setTimeout(() => {
      void fetchStatus().then(scheduleNextPoll);
    }, delay);
  }, [fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await ensureWatcher();
      if (cancelled) return;
      await fetchStatus();
      if (cancelled) return;
      scheduleNextPoll();
    })();

    const ensureTimer = setInterval(() => {
      void (async () => {
        await ensureWatcher();
        await fetchStatus();
        scheduleNextPoll();
      })();
    }, ENSURE_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(ensureTimer);
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [ensureWatcher, fetchStatus, scheduleNextPoll]);

  // Belt-and-braces against the browser's default drop behaviour: a file
  // dropped ANYWHERE outside a card's own drop handler makes the browser
  // NAVIGATE to that file, tearing the page — and the panel's whole reason to
  // exist is the two minutes around a print, when navigating away is the most
  // expensive thing the desk can accidentally do. The card handlers below
  // catch the aimed drops; this catches the misses.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  if (!loaded) {
    return (
      <section className="rounded-xl border border-edge bg-panel card-elev">
        <div className="px-5 py-3 border-b border-edge bg-raised rounded-t-xl">
          <h2
            className="font-mono uppercase font-semibold text-ink"
            style={{ fontSize: "12px", letterSpacing: "0.2em" }}
          >
            Live Print Watch
          </h2>
        </div>
        <p className="px-5 py-6 text-[13px] text-ink-faint">Loading print watch…</p>
      </section>
    );
  }

  if (statusError) {
    return (
      <section className="rounded-xl border border-edge bg-panel card-elev">
        <div className="px-5 py-3 border-b border-edge bg-raised rounded-t-xl">
          <h2
            className="font-mono uppercase font-semibold text-ink"
            style={{ fontSize: "12px", letterSpacing: "0.2em" }}
          >
            Live Print Watch
          </h2>
        </div>
        <p className="px-5 py-6 text-[13px] text-down">{statusError}</p>
      </section>
    );
  }

  // Today's expired prints STAY in the status response (final fix wave) —
  // the window closing is when the drop zone matters most. What vanishes is
  // disarmed prints and expired prints from earlier days, so an empty list is
  // the normal "nothing armed right now" state, not an error.
  if (prints.length === 0) {
    return (
      <EmptySection
        title="Live Print Watch"
        reason="No prints are currently armed and in an active watch window."
        hint="Arm an earnings worksheet (the Bogeys editor's print-day arm) and its watch window opens automatically ahead of the release — DJ wire, EDGAR, IR RSS, or a manual drop, whichever lands first."
      />
    );
  }

  return (
    <section className="rounded-xl border border-edge bg-panel card-elev">
      <div className="flex items-baseline justify-between flex-wrap gap-2 px-5 py-3 border-b border-edge bg-raised rounded-t-xl">
        <h2
          className="font-mono uppercase font-semibold text-ink"
          style={{ fontSize: "12px", letterSpacing: "0.2em" }}
        >
          Live Print Watch
        </h2>
        <span className="font-mono text-ink-faint" style={{ fontSize: "11px" }}>
          {printCountLabel(prints)}
        </span>
      </div>
      <div className="divide-y divide-edge">
        {prints.map((p) => (
          <PrintCard key={p.printId} print={p} onChanged={fetchStatus} />
        ))}
      </div>
    </section>
  );
}

// ── per-print card ──────────────────────────────────────────────────────

function PrintCard({ print, onChanged }: { print: PrintStatusEntry; onChanged: () => Promise<void> }) {
  const [acceptingAll, setAcceptingAll] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [unacceptingId, setUnacceptingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);

  const ladder = ladderText(print.sources);
  const summary = promoteSummary(print.lines);
  const agreedIds = print.lines.filter((l) => l.state === "agreed").map((l) => l.metric_id);
  const noEventId = print.eventId === undefined;

  async function postAccept(body: {
    accept?: string[];
    unaccept?: string[];
    promoteHeadline?: boolean;
    force?: boolean;
  }): Promise<boolean> {
    if (noEventId) {
      setActionError("This print has no event reference from the server — cannot accept.");
      return false;
    }
    try {
      const res = await apiFetch("/api/print-watch/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: print.eventId, ...body }),
      });
      const data = (await res.json().catch(() => null)) as AcceptResponse | null;
      if (!res.ok || !data?.success) {
        if (res.status === 409 && data?.code === "pre_print" && !body.force) {
          const confirmed = window.confirm(
            `${data.error ?? "This print's release time is still in the future."}\n\nPromote anyway?`,
          );
          if (confirmed) return postAccept({ ...body, force: true });
          // The panel's OWN cancellation copy, never the server's. The 409
          // body ends "…Confirm to save anyway" — echoing it back to someone
          // who just declined that confirm reads as an instruction they
          // already followed and leaves them looking for a second button.
          setActionError("Promote cancelled — release time is still in the future.");
          return false;
        }
        setActionError(data?.error ?? `Server returned ${res.status}`);
        return false;
      }
      setActionError(null);
      await onChanged();
      return true;
    } catch {
      setActionError("Could not reach the server.");
      return false;
    }
  }

  async function acceptAllAgreed() {
    if (acceptingAll || agreedIds.length === 0) return;
    setAcceptingAll(true);
    setActionNote(null);
    try {
      const ok = await postAccept({ accept: agreedIds });
      if (ok) setActionNote(`Accepted ${agreedIds.length} agreed line${agreedIds.length === 1 ? "" : "s"}.`);
    } finally {
      setAcceptingAll(false);
    }
  }

  async function promote() {
    if (promoting || !summary) return;
    setPromoting(true);
    setActionNote(null);
    try {
      const ok = await postAccept({ promoteHeadline: true });
      if (ok) setActionNote("Promoted to the earnings recap scoreboard.");
    } finally {
      setPromoting(false);
    }
  }

  async function unaccept(metricId: string) {
    if (unacceptingId) return;
    setUnacceptingId(metricId);
    setActionNote(null);
    try {
      const ok = await postAccept({ unaccept: [metricId] });
      if (ok) setActionNote(`Un-accepted ${metricId} — re-verify before accepting again.`);
    } finally {
      setUnacceptingId(null);
    }
  }

  async function handleDrop(file: File) {
    if (uploading) return;
    if (noEventId) {
      setActionError("This print has no event reference from the server — cannot upload.");
      return;
    }
    setUploading(true);
    setActionError(null);
    setActionNote(null);
    try {
      const contentBase64 = await fileToBase64(file);
      const res = await apiFetch("/api/print-watch/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: print.eventId, filename: file.name, contentBase64 }),
      });
      const data = (await res.json().catch(() => null)) as DropResponse | null;
      if (!res.ok || !data?.success) {
        setActionError(data?.error ?? `Upload failed: server returned ${res.status}.`);
        return;
      }
      // The server's verdict, verbatim — a 200 covers three outcomes and only
      // one of them is "the sheet moved".
      const message = dropOutcomeMessage(data.data?.outcome, data.data?.rejectReason);
      if (message.tone === "error") setActionError(message.text);
      else setActionNote(message.text);
      await onChanged();
    } catch {
      setActionError("Upload failed: could not reach the server.");
    } finally {
      setUploading(false);
    }
  }

  // A file dragged onto the card must land IN the card. Without these two
  // handlers the browser takes the drop itself and navigates the tab to the
  // dropped file — mid-print, with the sheet on screen. `preventDefault` on
  // dragover is what marks the card as a valid drop target in the first place
  // (the drop event never fires without it).
  function onDragOver(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (uploading || noEventId) return;
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(e: ReactDragEvent<HTMLDivElement>) {
    // Ignore the moves BETWEEN children — only a leave that exits the card
    // itself should drop the cue.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onDrop(e: ReactDragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = firstDroppedFile(e.dataTransfer);
    if (!file) {
      setActionError("That drop carried no file — drag the saved release (HTML or text) itself.");
      return;
    }
    void handleDrop(file);
  }

  const stateChip = printStateLabel(print.state);

  return (
    <div
      className={`px-5 py-4 transition-colors ${dragActive ? "bg-raised ring-1 ring-inset ring-gold/60" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1.5">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-medium text-ink" style={{ fontSize: "15px" }}>
            {print.symbol}
          </span>
          <Chip tone={stateChip.tone} size="xs" uppercase>
            {stateChip.text}
          </Chip>
        </div>
        <label
          className={`relative text-[12px] font-mono border border-edge rounded px-2 py-1 cursor-pointer hover:bg-raised pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 ${
            uploading ? "opacity-60 pointer-events-none" : ""
          }`}
          title={noEventId ? "This print has no event reference from the server — cannot upload." : "Drop or choose the release document (HTML/text)"}
        >
          {uploading ? "Uploading… (may take up to 30s)" : "⇪ Drop release"}
          <input
            type="file"
            accept=".html,.htm,.txt,text/html,text/plain"
            className="hidden"
            disabled={uploading || noEventId}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleDrop(file);
            }}
          />
        </label>
      </div>

      <p className="text-[11px] font-mono text-ink-faint mb-3">
        {ladder || "awaiting first poll — sources reset after a server restart"}
        {print.coverage.length > 0 && (
          <span className="block mt-0.5 text-ink-faint italic" style={{ fontSize: "10px" }}>
            {print.coverage.join(" · ")}
          </span>
        )}
      </p>

      {actionError && <p className="text-[12px] text-down mb-2">{actionError}</p>}
      {actionNote && !actionError && <p className="text-[12px] text-up mb-2">{actionNote}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr className="text-ink-faint font-mono uppercase" style={{ fontSize: "10px", letterSpacing: "0.14em" }}>
              <th className="text-left py-1.5 pr-3">Metric</th>
              <th className="text-left py-1.5 pr-3">Bogey</th>
              <th className="text-left py-1.5 pr-3">Actual</th>
              <th className="text-right py-1.5 pr-3">Δ vs bogey</th>
              <th className="text-left py-1.5 pr-3">State</th>
              <th className="text-left py-1.5">Detail</th>
            </tr>
          </thead>
          <tbody>
            {print.lines.map((line) => (
              <LineRow
                key={line.metric_id}
                line={line}
                documents={print.documents}
                onUnaccept={() => unaccept(line.metric_id)}
                unaccepting={unacceptingId === line.metric_id}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <button
          type="button"
          onClick={acceptAllAgreed}
          disabled={acceptingAll || agreedIds.length === 0 || noEventId}
          title={
            agreedIds.length === 0
              ? "No lines are in the agreed state yet."
              : `Accept ${agreedIds.length} agreed line(s)`
          }
          className="relative text-[13px] font-mono text-ink-dim hover:text-ink border border-edge rounded px-2.5 py-1 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
        >
          {acceptingAll ? "Accepting…" : `Accept all agreed (${agreedIds.length})`}
        </button>
        <button
          type="button"
          onClick={promote}
          disabled={promoting || !summary || noEventId}
          title={
            summary
              ? "Promote the accepted EPS + revenue pair to the recap scoreboard"
              : "Needs a complete accepted pair — an EPS line (adjusted or GAAP) AND revenue_q, both accepted"
          }
          className="relative text-[13px] font-semibold bg-up/15 text-up border border-up/40 hover:bg-up/25 disabled:opacity-50 rounded px-2.5 py-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
        >
          {promoting ? "Promoting…" : summary ? summary.label : "Promote EPS+Rev"}
        </button>
      </div>
    </div>
  );
}

// ── per-line row ────────────────────────────────────────────────────────

function LineRow({
  line,
  documents,
  onUnaccept,
  unaccepting,
}: {
  line: PrintWatchLine;
  documents: Record<number, string> | undefined;
  onUnaccept: () => void;
  unaccepting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const presentation = presentState(line);
  const basis = basisNote(line.contract);
  const delta = deltaPct(line.expected?.value ?? null, line.value);
  const isFlash = line.state === "flash";

  let candidates: TaggedCandidate[] = [];
  if (line.state === "conflict") {
    try {
      const parsed = JSON.parse(line.candidates_json) as unknown;
      if (Array.isArray(parsed)) candidates = parsed as TaggedCandidate[];
    } catch {
      candidates = [];
    }
  }

  return (
    <>
      <tr className={`border-t border-edge ${isFlash ? "border-dashed" : ""}`}>
        <td className="py-2 pr-3 align-top">
          <span className="text-ink">{line.contract.label}</span>
          {basis && <span className="ml-1.5 text-[10px] text-ink-faint uppercase">{basis}</span>}
          {line.contract.segment && (
            <span className="block text-[10px] text-ink-faint">{line.contract.segment}</span>
          )}
        </td>
        <td className="py-2 pr-3 align-top font-mono tabular-nums">
          <PrivateText className="text-ink-dim">
            {line.expected
              ? [
                  formatContractRange(line.contract, line.expected.value, line.expected.value_high),
                  line.expected.whisper !== null
                    ? `whisper ${formatContractValue(line.contract, line.expected.whisper)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "—"}
          </PrivateText>
        </td>
        <td className="py-2 pr-3 align-top font-mono tabular-nums text-ink">
          {formatContractRange(line.contract, line.value, line.value_high)}
        </td>
        <td
          className={`py-2 pr-3 align-top text-right font-mono tabular-nums ${
            delta === null ? "text-ink-faint" : delta.sign === 1 ? "text-up" : delta.sign === -1 ? "text-down" : "text-ink-dim"
          }`}
        >
          {delta ? delta.label : "—"}
        </td>
        <td className="py-2 pr-3 align-top">
          <Chip tone={presentation.tone} size="xs">
            <span className="mr-1">{presentation.icon}</span>
            {presentation.text}
          </Chip>
          {line.state === "accepted" && (
            <button
              type="button"
              onClick={onUnaccept}
              disabled={unaccepting}
              className="relative block mt-1 text-[11px] text-ink-faint hover:text-down disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            >
              {unaccepting ? "Un-accepting…" : "unaccept"}
            </button>
          )}
        </td>
        <td className="py-2 align-top">
          {(line.snippet || candidates.length > 0) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="relative text-[11px] text-ink-faint hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']"
            >
              {expanded ? "hide ▲" : "snippet ▾"}
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className={`border-t-0 ${isFlash ? "border-dashed" : ""}`}>
          <td colSpan={6} className="pb-2.5 pr-3">
            {line.state === "conflict" && candidates.length > 0 ? (
              <ul className="space-y-1">
                {candidates.map((c, i) => (
                  <li key={`${c.doc_id}-${c.representation}-${i}`} className="text-[11px] text-ink-dim font-mono">
                    <span className="text-ink-faint">{candidateSourceLabel(c, documents)}:</span>{" "}
                    {c.not_disclosed
                      ? "not disclosed"
                      : formatContractRange(line.contract, c.value, c.value_high)}
                    {c.snippet && <span className="text-ink-faint italic"> — “{c.snippet}”</span>}
                  </li>
                ))}
              </ul>
            ) : line.snippet ? (
              <p className="text-[11px] text-ink-faint italic">“{line.snippet}”</p>
            ) : (
              <p className="text-[11px] text-ink-faint italic">No snippet captured for this line yet.</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
