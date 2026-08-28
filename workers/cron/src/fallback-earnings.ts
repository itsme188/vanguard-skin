/**
 * Cloud-fallback earnings preview/recap emails — runs when the Mac primary
 * sweep is unreachable.
 *
 * Lean by design: the fallback email is intentionally a compact "actuals +
 * reaction + positions" version with a footer disclosing limited context.
 * The Mac primary path produces the rich version with newsletter bogies,
 * analyst recs, prior transcripts, and user notes — none of which are
 * mirrored here. Reasoning:
 *   - Parallel composer would diverge from Mac the moment we iterate on
 *     prompts; user explicitly flagged email content iteration as next.
 *   - For the rare Mac-offline-during-earnings case, getting actuals +
 *     reaction promptly beats waiting for nothing.
 *   - When the Mac composer's content has soaked, we can mirror more of it
 *     to the fallback in a separate Phase.
 *
 * Flow:
 *   1. Read R2 snapshot (must be schemaVersion ≥ 2 — earlier snapshots
 *      lack holdings/securities/accounts and the fallback no-ops).
 *   2. Find candidate earnings events:
 *      - Preview window: release_time IS NOT NULL AND
 *        now+105min ≤ release_instant ≤ now+120min (narrowed from 135 — see
 *        the Mac-first tick offset comment on PREVIEW_WINDOW_MAX_MS below;
 *        the Mac primary sweep still uses the full [105,135] band)
 *      - Recap window: enriched_at IS NOT NULL AND
 *        now ≤ enriched_at + 4h
 *   3. Filter to held|watchlist (snapshot.heldSymbols) + earningsSettings
 *      (master toggle + muted symbols).
 *   4. Skip events Mac already audited (snapshot.earningsEmails) OR with
 *      mac-sent-* / cloud-sent-* / mac-running-* markers in KV.
 *   5. For each candidate: compose lean email, send via Worker Gmail,
 *      write cloud-sent marker.
 */

import type {
  Snapshot,
  CalendarEventRow,
  HoldingRow,
  SecurityRow,
  AccountRow,
  EarningsEmailRow,
  SnapshotNote,
  SnapshotBogey,
  EarningsIntelSnapshotRow,
  EarningsHistorySnapshotEntry,
  EarningsHistorySnapshotRow,
} from "./state";
import { loadLatestSnapshot } from "./state";
import { briefingToHtml } from "./html";
import { sendEmail } from "./resend";
import { composeReleaseInstant } from "./reaction-matcher";
import { captureReactionFromYahoo } from "./yahoo";
import {
  formatPositionPresence,
  formatCombinedExposurePresence,
} from "./presence-position";
import { ibkrConfigFromEnv } from "./ibkr-oauth";
import {
  fetchLiveIbkrPositionsCached,
  combineFamilyPositions,
  type LiveIbkrPosition,
} from "./ibkr-positions";
import {
  earningsMarkerKey,
  earningsRunningKey,
  readEarningsMarkers,
  writeEarningsMarker,
  type EarningsPhase,
} from "./earnings-markers";
import {
  cloudEnrichedKey,
  isPayloadComplete,
  type CloudEnrichedPayload,
} from "./cloud-enriched";
import { isPlausibleEarnings } from "./plausibility";
import { resolveExpectedMove } from "./expected-move";
import { formatEtTimestamp, todayET } from "./dst";

// Issuer-family map mirrored from lib/securities/issuer-family.ts. Worker
// can't cross the Next.js path-alias boundary, so this is a hand copy.
// Keep in sync; new families are slow-moving (rare additions). Exported so
// other Worker modules (e.g. calendar-enrich.ts's push-at-print hook) reuse
// this single Worker-side copy instead of hand-copying the family list again.
export const ISSUER_FAMILIES: ReadonlyArray<readonly string[]> = [
  ["GOOG", "GOOGL"],
  ["BRK A", "BRK B", "BRK.A", "BRK.B", "BRK/A", "BRK/B", "BRK-A", "BRK-B"],
  ["FOX", "FOXA"],
  ["NWS", "NWSA"],
  ["UA", "UAA"],
  ["LBRDA", "LBRDK"],
  ["LSXMA", "LSXMK"],
  ["HEI", "HEI.A", "HEI/A"],
];

const FAMILY_BY_SYMBOL = new Map<string, readonly string[]>();
for (const fam of ISSUER_FAMILIES) {
  for (const s of fam) FAMILY_BY_SYMBOL.set(s.toUpperCase(), fam);
}

export function issuerSiblings(symbol: string): readonly string[] {
  if (!symbol) return [];
  const fam = FAMILY_BY_SYMBOL.get(symbol.toUpperCase());
  return fam ?? [symbol.toUpperCase()];
}

// Mac-aliveness marker key — written by the Mac after every successful
// earnings-sweep tick (POST /internal/mac-recent-earnings-sweep, 25-min TTL).
// Sibling of level-scan's `mac-recent-scan`. Consulted for PREVIEWS only.
const KV_MAC_SWEEP_MARKER = "mac-recent-earnings-sweep";

const PREVIEW_WINDOW_MIN_MS = 105 * 60 * 1000;
// Mac-first tick offset (final-review fix pass): the Mac primary sweep's
// candidate window is the FULL [105,135] min-until-release band (both sides
// used to share it), so whichever side's ~15-min cron tick landed first inside
// that 30-min window won EVERY day — an awake Mac still lost half the time to
// a Worker tick that happened to fire first, silently degrading the user to
// the lean cloud preview all season. Narrowed to 120 so the Worker never sees
// a candidate until the Mac's [120,135] band has already had a full 15-min
// tick cycle to claim it (mac-sent/mac-running markers) — same "Worker email
// dispatches sit ONE tick AFTER the Mac's window, never ON it" convention as
// the digest/briefing/evening dispatch offsets (see CLAUDE.md launchd
// section). Recap window road 1 (snapshot enriched_at) is untouched — its
// 4h band already gives ample Mac-first berth. Road 2 (same-day KV probe,
// added in B8) earns its Mac-first berth a different way — see the comment
// at the KV probe site in findCandidatesFromSnapshot below.
const PREVIEW_WINDOW_MAX_MS = 120 * 60 * 1000;
const RECAP_WINDOW_MAX_MS = 4 * 60 * 60 * 1000;

export interface FallbackEnv {
  CRON_KV: KVNamespace;
  ARCHIVE: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
  WORKER_GMAIL_CLIENT_ID?: string;
  WORKER_GMAIL_CLIENT_SECRET?: string;
  WORKER_GMAIL_REFRESH_TOKEN?: string;
  BRIEFING_EMAIL_TO?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_DOMAIN?: string;
  // Tier 3: live IBKR position refresh. All optional — when unset, the composer
  // degrades to the (possibly stale) snapshot positions.
  IBKR_CONSUMER_KEY?: string;
  IBKR_ACCESS_TOKEN?: string;
  IBKR_PREPEND?: string;
  IBKR_DH_PRIME?: string;
  IBKR_SIGNATURE_KEY_PKCS8?: string;
  IBKR_DH_GENERATOR?: string;
  IBKR_BASE_URL?: string;
  IBKR_REALM?: string;
}

export interface EarningsFallbackResult {
  swept: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Last per-candidate failure message — surfaced so an all-fail run is diagnosable. */
  lastError?: string;
  details: Array<{
    eventId: number;
    symbol: string;
    phase: EarningsPhase;
    status: "sent" | "skipped" | "failed";
    reason?: string;
  }>;
}

interface SnapshotCandidate {
  eventId: number;
  symbol: string;
  phase: EarningsPhase;
  event: CalendarEventRow;
  /** Present on KV-road recap candidates — carries same-day cloud-enriched data. */
  payload?: CloudEnrichedPayload | null;
}

interface ScanSkip {
  eventId: number;
  symbol: string;
  phase: EarningsPhase;
  reason: string;
}

// KV probe band: release within the last 12h (enrich retry window) + 4h
// (recap window). Outside it a payload can't produce an unexpired recap.
const KV_PROBE_WINDOW_MS = 16 * 60 * 60 * 1000;

// B13: per-run candidate cap. Each sent candidate costs ~5 subrequests (3 KV
// marker reads + 1 Resend fetch + 1 KV marker write), and the single */15
// invocation's 50-subrequest free-tier budget is shared with calendar-enrich
// (itself capped at 10 candidates). Uncapped, a clustered AMC night dies
// mid-loop — the Nth send throws "Too many subrequests" AFTER earlier
// candidates' markers already committed, and nothing retries the rest.
// 5 × ~5 = ~25 subrequests for sends, leaving headroom for the snapshot R2
// read, the IBKR live refresh, and recap-road-2 KV probes.
const MAX_CANDIDATES_PER_RUN = 5;

// ── EOD earnings wrap — SUPPRESS-ONLY since 2026-08-02 ─────────────────────────
//
// When ≥ WRAP_THRESHOLD expected-unsent recaps share a (date, slot), the
// cluster's members are suppressed from individual cloud recap sends — and
// NOTHING replaces them from the cloud. The old behavior (staple them into one
// "Earnings wrap" email at the slot deadline) is retired: the user judged the
// 20:00 staple worthless, and heavy-night names now roll into the Mac's
// morning debrief (lib/earnings/debrief-send.ts, 07:45–08:20 ET, 3-day
// self-healing lookback). Accepted trade-off (spec
// docs/superpowers/specs/2026-08-02-outbound-privacy-parity-design.md): if the
// Mac also sleeps through the debrief window, coverage waits for the debrief's
// self-heal — there is no cloud debrief. Quiet nights (< threshold) still get
// individual cloud recaps.

export const WRAP_THRESHOLD = 3;

export type WrapSlot = "BMO" | "AMC";

// Parity with lib/earnings/wrap.ts::SLOT_DEADLINES_ET (user-set 2026-07-16).
// No longer consulted by the suppress-only wrap (nothing fires at a deadline
// anymore) but kept byte-identical for the wrap-parity pin, matching the Mac
// side's own retired-but-kept wrap constants.
export const SLOT_DEADLINES_ET: Record<WrapSlot, string> = {
  BMO: "12:00",
  AMC: "20:00",
};

/**
 * Slot classification mirroring lib/earnings/wrap.ts::wrapSlotFor EXACTLY —
 * FIXED precedence: event_time exact "BMO"/"AMC" (after trim+uppercase) →
 * title PHRASE "BEFORE MARKET"/"AFTER MARKET" only (never a bare "BMO"/"AMC"
 * substring — a ticker like Bank of Montreal collides) → release_time < "12:00".
 * Returns null for a TBD slot (never clusters).
 */
export function wrapSlotForCloud(e: {
  event_time?: unknown;
  title?: unknown;
  release_time?: unknown;
}): WrapSlot | null {
  const marker = String(e.event_time ?? "").trim().toUpperCase();
  if (marker === "BMO") return "BMO";
  if (marker === "AMC") return "AMC";
  const title = String(e.title ?? "").toUpperCase();
  if (title.includes("BEFORE MARKET")) return "BMO";
  if (title.includes("AFTER MARKET")) return "AMC";
  const rt = e.release_time;
  if (typeof rt === "string" && rt) return rt < "12:00" ? "BMO" : "AMC";
  return null;
}

interface WrapMember {
  eventId: number;
  symbol: string;
}

/**
 * Collapse rows whose symbols share an issuer family down to one survivor —
 * mirrors lib/earnings/wrap.ts::dedupeByFamily (finnhub wins, ties → lowest id).
 * getEarningsForWeekDeduped-style symbol partitioning on the Mac leaves
 * cross-source dual-class duplicates (GOOG + GOOGL for the same print) that
 * would otherwise double-count toward WRAP_THRESHOLD.
 */
function dedupeClusterByFamily(events: CalendarEventRow[]): CalendarEventRow[] {
  const rank = (e: CalendarEventRow) => (e.source === "finnhub" ? 0 : 1);
  const keyOf = (e: CalendarEventRow) =>
    issuerSiblings((e.symbol as string) ?? "")
      .map((s) => s.toUpperCase())
      .sort()
      .join(",");
  const winners = new Map<string, CalendarEventRow>();
  for (const e of events) {
    const key = keyOf(e);
    const cur = winners.get(key);
    if (!cur || rank(e) < rank(cur) || (rank(e) === rank(cur) && e.id < cur.id)) {
      winners.set(key, e);
    }
  }
  return events.filter((e) => winners.get(keyOf(e)) === e);
}

/**
 * The expected-unsent recap cluster for one (date, slot), from the snapshot:
 * earnings rows for today (ET) in the slot, held/watchlist family-aware, not
 * superseded, not muted, without a completed/sent-by-cloud recap audit row,
 * family-deduped. Membership is all that matters now (suppress-only wrap) —
 * the old readiness probe (snapshot actual / cloud-enriched KV payload) is
 * gone with the staple send, which also drops its per-member KV reads from
 * the tick's subrequest budget.
 *
 * SKIPS DIVERGENCE: the R2 snapshot does NOT ship earnings_email_skips (a
 * Mac-only table), so a per-(event,phase) recap skip can't be honored here.
 * Accepted pre-existing limitation — the individual cloud recap path
 * (findCandidatesFromSnapshot) ignores earnings_email_skips too; a Mac-side
 * skip is honored only while the Mac is awake.
 */
function buildWrapCluster(
  snapshot: Snapshot,
  slot: WrapSlot,
  date: string,
): WrapMember[] {
  const heldSet = new Set(snapshot.heldSymbols.map((s) => s.toUpperCase()));
  const watchSet = new Set(
    (snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()),
  );
  const muted = new Set(
    (snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()),
  );
  // Completed local send (error IS NULL) or sent-by-cloud rows exclude the
  // member; a live 'in_progress' claim does NOT — nothing delivered yet.
  const auditedRecap = new Set(
    (snapshot.earningsEmails ?? [])
      .filter((r) => r.phase === "recap" && r.error !== "in_progress")
      .map((r) => r.event_id),
  );

  const raw: CalendarEventRow[] = [];
  for (const e of snapshot.calendarEvents) {
    if (e.event_type !== "earnings") continue;
    if (!e.symbol) continue;
    if (e.superseded) continue;
    if (e.event_date !== date) continue;
    if (wrapSlotForCloud(e) !== slot) continue;
    const family = issuerSiblings(e.symbol).map((s) => s.toUpperCase());
    if (!family.some((f) => heldSet.has(f) || watchSet.has(f))) continue;
    if (family.some((f) => muted.has(f))) continue;
    if (auditedRecap.has(e.id)) continue;
    raw.push(e);
  }

  return dedupeClusterByFamily(raw).map((e) => ({
    eventId: e.id,
    symbol: (e.symbol as string).toUpperCase(),
  }));
}

/**
 * B13 priority order under the cap: previews first, closest release first,
 * recaps last. Rationale: the Worker preview window is one tick wide
 * ([105,120] min-until-release) — a preview deferred past its window is LOST,
 * and the closest-to-release preview exits the window soonest. A recap's 4h
 * window means a deferred recap reliably lands on the next 15-min tick.
 * Recaps keep scan order among themselves (sort is stable).
 */
function prioritizeCandidates(
  candidates: SnapshotCandidate[],
  now: Date,
): SnapshotCandidate[] {
  const nowMs = now.getTime();
  const rank = (c: SnapshotCandidate): number => {
    if (c.phase === "recap") return Number.MAX_SAFE_INTEGER;
    const instant = c.event.release_time
      ? composeReleaseInstant(c.event.event_date, c.event.release_time as string)
      : null;
    // A preview always has a parseable release instant (the scan required it
    // to enter the window) — the fallback is pure defense.
    return instant ? instant.getTime() - nowMs : Number.MAX_SAFE_INTEGER - 1;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b));
}

export async function runEarningsFallback(
  env: FallbackEnv,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<EarningsFallbackResult> {
  const result: EarningsFallbackResult = {
    swept: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const snapshot = await loadLatestSnapshot(env.ARCHIVE);
  if (!snapshot) return result;
  if (snapshot.schemaVersion < 2) return result; // older snapshots lack earnings ctx

  // Master toggle.
  if (snapshot.earningsSettings && !snapshot.earningsSettings.enabled) {
    return result;
  }

  const now = opts.now ?? new Date();
  const date = todayET(now);

  // EOD wrap — suppress-only (2026-08-02, see the wrap section header above):
  // a slot at/over WRAP_THRESHOLD is in WRAP MODE — its recap members are
  // suppressed from individual cloud recap sends and NOTHING replaces them
  // from the cloud; the names roll into the Mac's next morning debrief.
  // AMC ONLY (2026-08-04 decision, parity with lib/calendar/email-sweep.ts):
  // the defer-to-debrief rationale is AMC-specific — a BMO cluster's
  // individual recaps land the same morning, so BMO never suppresses.
  const suppressedRecapIds = new Set<number>();
  {
    const cluster = buildWrapCluster(snapshot, "AMC", date);
    if (cluster.length >= WRAP_THRESHOLD) {
      for (const m of cluster) {
        suppressedRecapIds.add(m.eventId);
        result.swept++;
        result.skipped++;
        result.details.push({
          eventId: m.eventId,
          symbol: m.symbol,
          phase: "recap",
          status: "skipped",
          reason: "wrap-suppressed-for-debrief",
        });
      }
    }
  }

  const scan = await findCandidatesFromSnapshot(snapshot, now, env.CRON_KV, suppressedRecapIds);

  // Mac-aliveness gate — PREVIEWS ONLY (2026-08-05, the APP/MELI race). The
  // Mac posts `mac-recent-earnings-sweep` (25-min TTL) after every successful
  // sweep tick; a fresh marker means the Mac is alive and its wider [105,135]
  // preview window will cover the send — without this, launchd drift (the
  // StartInterval re-anchor after a 60-180s compose) lets the Worker's fixed
  // :00/:15 grid tick cloud-send a lean preview the awake Mac would have sent
  // rich minutes later. Recaps + actuals-capture stay UN-gated: they're
  // additive (per-event markers already dedup them) and time-critical after a
  // print. Gated previews stay markerless so a later tick retries if the Mac
  // dies and the marker expires while the window is still open.
  let candidateList = scan.candidates;
  const macSweptAt = await env.CRON_KV.get(KV_MAC_SWEEP_MARKER);
  if (macSweptAt) {
    const gatedPreviews = candidateList.filter((c) => c.phase === "preview");
    if (gatedPreviews.length > 0) {
      candidateList = candidateList.filter((c) => c.phase !== "preview");
      console.log(
        `[fallback-earnings] mac-recent-earnings-sweep marker present (${macSweptAt}) — skipping ${gatedPreviews.length} preview candidate(s)`,
      );
      for (const g of gatedPreviews) {
        result.swept++;
        result.skipped++;
        result.details.push({
          eventId: g.eventId,
          symbol: g.symbol,
          phase: "preview",
          status: "skipped",
          reason: "mac-recently-swept",
        });
      }
    }
  }

  const prioritized = prioritizeCandidates(candidateList, now);
  // ALL discovered candidates, incl. deferred (+= keeps the wrap-suppressed
  // members counted above).
  result.swept += prioritized.length;
  for (const s of scan.skips) {
    result.skipped++;
    result.details.push({ eventId: s.eventId, symbol: s.symbol, phase: s.phase, status: "skipped", reason: s.reason });
  }
  // B13: cap the processed set; overflow is reported (never silently dropped)
  // and left markerless so the next 15-min tick retries it.
  const candidates = prioritized.slice(0, MAX_CANDIDATES_PER_RUN);
  const deferred = prioritized.slice(MAX_CANDIDATES_PER_RUN);
  if (deferred.length > 0) {
    console.warn(
      `[fallback-earnings] candidate cap: processing ${candidates.length} of ${prioritized.length}, deferring ${deferred.length} to next tick`,
    );
    for (const d of deferred) {
      result.skipped++;
      result.details.push({
        eventId: d.eventId,
        symbol: d.symbol,
        phase: d.phase,
        status: "skipped",
        reason: "deferred-cap",
      });
    }
  }
  if (candidates.length === 0) return result;

  // Tier 3 — live IBKR refresh. The snapshot's IBKR rows can be days stale while
  // the Mac is asleep (travel), so an earnings email might show a position the
  // user has since exited or resized. Lazy + memoized: only fetched the FIRST
  // time a candidate actually composes, so a tick where every candidate is
  // marker-skipped never opens an IBKR session for nothing (one LST mint per
  // run, at most, reused across candidates).
  // Best-effort: any failure degrades to the snapshot positions. Never run on
  // dry-run (no network).
  const ibkrAccountName = resolveIbkrAccountName(snapshot);
  let liveIbkrCache: LiveIbkrPosition[] | null = null;
  let liveIbkrTried = false;
  const getLiveIbkr = async (): Promise<LiveIbkrPosition[] | null> => {
    // Check-and-set memo is not re-entrant-safe; all callers await sequentially — do not parallelize without switching to a shared in-flight promise.
    if (liveIbkrTried) return liveIbkrCache;
    liveIbkrTried = true;
    if (opts.dryRun) return null;
    const ibkrCfg = ibkrConfigFromEnv(
      env as unknown as Record<string, string | undefined>,
    );
    if (!ibkrCfg) return null;
    try {
      liveIbkrCache = await fetchLiveIbkrPositionsCached(env.CRON_KV, ibkrCfg);
      console.log(`[fallback-earnings] live IBKR refresh: ${liveIbkrCache.length} positions`);
    } catch (err) {
      // The sentinel-prefixed error is the Worker-side caller half of the
      // polite-yield throw in ibkr-positions.ts (compete:"false" — an active
      // TWS session wins, we degrade quietly rather than log it as a failure).
      if (err instanceof Error && err.message.includes("ibkr-session-yield")) {
        console.log("[fallback-earnings] IBKR session yielded to active TWS — using snapshot positions");
      } else {
        console.warn("[fallback-earnings] live IBKR refresh failed, using snapshot:", err);
      }
    }
    return liveIbkrCache;
  };

  for (const cand of candidates) {
    const markers = await readEarningsMarkers(env.CRON_KV, cand.phase, cand.eventId);
    if (markers.mac || markers.cloud || markers.macRunning) {
      result.skipped++;
      result.details.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        status: "skipped",
        reason: markers.cloud ? "cloud-already-sent" : markers.mac ? "mac-already-sent" : "mac-running",
      });
      continue;
    }

    let implausible = false;
    if (cand.phase === "recap") {
      const verdict = evaluateRecapContent(cand.event, cand.payload ?? null);
      if (!verdict.send) {
        result.skipped++;
        result.details.push({
          eventId: cand.eventId,
          symbol: cand.symbol,
          phase: cand.phase,
          status: "skipped",
          reason: verdict.reason,
        });
        continue;
      }
      implausible = verdict.implausible;
    }

    if (opts.dryRun) {
      result.details.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        status: "sent",
        reason: "dry-run",
      });
      result.sent++;
      continue;
    }

    try {
      const liveIbkr = await getLiveIbkr();
      await composeAndSend(env, snapshot, cand, liveIbkr, ibkrAccountName, implausible);
      await writeEarningsMarker(env.CRON_KV, "cloud", cand.phase, cand.eventId);
      result.sent++;
      result.details.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        status: "sent",
      });
    } catch (err) {
      result.failed++;
      result.lastError = err instanceof Error ? err.message : String(err);
      result.details.push({
        eventId: cand.eventId,
        symbol: cand.symbol,
        phase: cand.phase,
        status: "failed",
        reason: result.lastError,
      });
    }
  }

  return result;
}

async function findCandidatesFromSnapshot(
  snapshot: Snapshot,
  now: Date,
  kv: KVNamespace,
  // Recap event ids claimed by a wrap-mode cluster (#17 T4) — their individual
  // recap sends are suppressed (road-1 AND road-2), and road-2's KV probe is
  // skipped so the wrap owns the only read. Defaults empty → no behavior change.
  suppressedRecapIds: Set<number> = new Set(),
): Promise<{ candidates: SnapshotCandidate[]; skips: ScanSkip[] }> {
  const nowMs = now.getTime();
  const heldSet = new Set(snapshot.heldSymbols.map((s) => s.toUpperCase()));
  const watchSet = new Set(
    (snapshot.watchlistSymbols ?? []).map((s) => s.toUpperCase()),
  );
  const muted = new Set(
    (snapshot.earningsSettings?.mutedSymbols ?? []).map((s) => s.toUpperCase()),
  );
  const auditKey = (eventId: number, phase: EarningsPhase) => `${eventId}:${phase}`;
  // Skip live 'in_progress' claim rows — a claim (in-flight or crashed Mac
  // send) hasn't delivered anything, so it must not suppress the cloud
  // fallback. The 2am R2 snapshot can ship a claim that's still alive (or
  // stale-and-never-reaped) at scan time, which would otherwise block the
  // cloud path for that (event, phase) for the rest of the day. 'sent-by-
  // cloud' and completed local-send rows (error IS NULL) DO count as audited.
  const auditedSet = new Set(
    (snapshot.earningsEmails ?? [])
      .filter((r) => r.error !== "in_progress")
      .map((r) => auditKey(r.event_id, r.phase)),
  );

  const out: SnapshotCandidate[] = [];
  const skips: ScanSkip[] = [];

  for (const e of snapshot.calendarEvents) {
    if (e.event_type !== "earnings") continue;
    if (!e.symbol) continue;
    // Cross-source duplicate guard: one print can carry two calendar rows
    // (finnhub + nasdaq). The Mac's reconcileEarningsDates marks the
    // non-canonical row superseded=1 and the Mac sweep filters it in SQL;
    // the snapshot ships the flag (SELECT *), so honor it here too —
    // otherwise each source row sends its own email (2026-07-14: JPM/BAC
    // previews doubled while the Mac slept).
    if (e.superseded) continue;
    const sym = e.symbol.toUpperCase();
    // B20: family walk so a GOOGL event with GOOG held isn't dropped, plus
    // watchlist coverage (snapshot v8 ships watchlistSymbols; older
    // snapshots degrade to held-only via ?? []). Mirrors the push-at-print
    // gate in calendar-enrich.ts.
    const family = issuerSiblings(sym).map((s) => s.toUpperCase());
    if (!family.some((f) => heldSet.has(f) || watchSet.has(f))) continue;
    if (family.some((f) => muted.has(f))) continue;

    // Preview candidate
    if (e.release_time && !auditedSet.has(auditKey(e.id, "preview"))) {
      const releaseInstant = composeReleaseInstant(e.event_date, e.release_time as string);
      if (releaseInstant) {
        const msUntilRelease = releaseInstant.getTime() - nowMs;
        if (msUntilRelease >= PREVIEW_WINDOW_MIN_MS && msUntilRelease <= PREVIEW_WINDOW_MAX_MS) {
          out.push({ eventId: e.id, symbol: sym, phase: "preview", event: e });
        }
      }
    }

    // Recap — road 1 (snapshot enriched_at, pre-2am enrichment). B8 gates on
    // an actual being present — evaluateRecapContent re-checks at send time
    // (belt-and-suspenders), but gating here keeps a no-actual row out of
    // `swept` entirely and reports it as a scan-level skip.
    // Wrap mode owns this event's recap — never send it individually.
    if (suppressedRecapIds.has(e.id)) continue;
    const enrichedAt = (e as Record<string, unknown>).enriched_at as string | null | undefined;
    const recapAudited = auditedSet.has(auditKey(e.id, "recap"));
    if (enrichedAt && !recapAudited) {
      const enrichedMs = Date.parse(enrichedAt.replace(" ", "T") + "Z");
      if (Number.isFinite(enrichedMs)) {
        const ageMs = nowMs - enrichedMs;
        if (ageMs >= 0 && ageMs <= RECAP_WINDOW_MAX_MS) {
          if (((e as Record<string, unknown>).actual_value ?? null) == null) {
            skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "no-actual" });
          } else {
            out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e });
          }
        }
      }
    } else if (!enrichedAt && !recapAudited && e.release_time) {
      // Recap — road 2 (B8): same-day cloud-enriched KV payload, invisible to
      // the 2am snapshot. Probe KV only inside the release band (bounded reads).
      // Awake-Mac-first guard for THIS road: the Mac's reconcile
      // (lib/calendar/cloud-reconcile.ts, chained into its 15-min enrich
      // script) DELETES the payload within one tick of waking, so an awake
      // Mac always consumes the payload before the Worker's next recap tick
      // can see it. If reconcile ever stops deleting keys, this road needs
      // an explicit Mac-first berth of its own — same race family as the
      // 6/3–6/9 digest incident.
      const releaseInstant = composeReleaseInstant(e.event_date, e.release_time as string);
      if (releaseInstant) {
        const sinceRelease = nowMs - releaseInstant.getTime();
        if (sinceRelease >= 0 && sinceRelease <= KV_PROBE_WINDOW_MS) {
          try {
            const raw = await kv.get(cloudEnrichedKey(e.id));
            if (!raw) {
              skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "payload-missing" });
            } else {
              const payload = JSON.parse(raw) as CloudEnrichedPayload;
              if (!isPayloadComplete(payload, releaseInstant, nowMs)) {
                skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "payload-incomplete" });
              } else {
                const readyMs = Date.parse(payload.fetchedAt);
                if (Number.isFinite(readyMs) && nowMs - readyMs >= 0 && nowMs - readyMs <= RECAP_WINDOW_MAX_MS) {
                  out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e, payload });
                }
                // fetchedAt outside the 4h window → expired recap, silent
                // (mirrors the snapshot road's silent expiry).
              }
            }
          } catch (err) {
            console.warn(`[fallback-earnings] KV probe failed for event ${e.id}:`, err);
            skips.push({ eventId: e.id, symbol: sym, phase: "recap", reason: "kv-error" });
          }
        }
      }
    }
  }

  return { candidates: out, skips };
}

async function composeAndSend(
  env: FallbackEnv,
  snapshot: Snapshot,
  cand: SnapshotCandidate,
  liveIbkr: LiveIbkrPosition[] | null,
  ibkrAccountName: string,
  implausible: boolean,
): Promise<void> {
  if (!env.BRIEFING_EMAIL_TO) {
    throw new Error("BRIEFING_EMAIL_TO missing");
  }
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    throw new Error("RESEND_API_KEY / RESEND_FROM_DOMAIN missing");
  }

  const family = issuerSiblings(cand.symbol);
  // Live IBKR (current book) replaces the snapshot's stale IBKR rows; Vanguard/
  // Roth rows stay from the snapshot. When live is null, this is the snapshot
  // verbatim (prior behavior).
  const snapshotViews = resolvePositions(snapshot, family);
  const positions = combineFamilyPositions(snapshotViews, liveIbkr, family, ibkrAccountName);
  const { sections, hasNotes, hasBogeys } = renderCandidateSections(
    snapshot,
    cand,
    positions,
    liveIbkr !== null,
    implausible,
  );

  const release = cand.event.release_time
    ? ` ${cand.event.release_time} ET`
    : "";
  const phaseLabel = cand.phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const phaseEmoji = cand.phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
  const dateLabel = formatDate(cand.event.event_date);
  const title = `${cand.symbol} ${phaseLabel} — ${dateLabel}${release}`;

  // Sections (scoreboard → past prints → positions → bogeys → notes) plus the
  // per-candidate cloud-context note. Empty blocks already dropped inside
  // renderCandidateSections; sections is always non-empty (scoreboard renders
  // unconditionally), so the join is byte-identical to the prior 6-block join.
  const body = [sections, renderNote(cand.phase, { hasNotes, hasBogeys })]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  const included: string[] = [];
  if (hasBogeys) included.push("your curated bogeys");
  if (hasNotes) included.push("your prior notes");
  const includedNote =
    included.length > 0 ? ` ${included.join(" + ")} ARE included above.` : "";
  const footer = `Cloud fallback delivery (state snapshot ${snapshot.snapshotDate}) — the Mac didn't complete this send in time (asleep, unreachable, or its compose failed).${includedNote} Analyst recs, transcripts, and sell-side web-search are only in the Mac primary version.`;
  const html = briefingToHtml(body, title, footer);

  await sendEmail(env, {
    to: env.BRIEFING_EMAIL_TO,
    subject: `${phaseEmoji} ${title}`,
    html,
    fromLocalPart: "earnings",
  });
}

/**
 * The per-name markdown body (scoreboard → past prints → positions → bogeys →
 * notes) for one candidate, shared by the individual recap/preview path
 * (composeAndSend). Formerly also shared by the retired EOD wrap staple —
 * kept caller-resolves-`positions` shape unchanged. Excludes the trailing
 * cloud-context note + email footer.
 */
function renderCandidateSections(
  snapshot: Snapshot,
  cand: SnapshotCandidate,
  positions: PositionView[],
  ibkrLive: boolean,
  implausible: boolean,
): { sections: string; hasNotes: boolean; hasBogeys: boolean } {
  const family = issuerSiblings(cand.symbol);
  const intelCtx = resolveIntelCtx(snapshot, cand.eventId, cand.symbol);
  const scoreboard = renderScoreboard(cand.event, cand.phase, cand.payload ?? null, implausible, intelCtx);
  const positionsBlock = renderPositions(positions, cand.symbol, family, ibkrLive);
  // "## Past prints" — preview-only, same slot as the Mac (right after the
  // scoreboard). "" (no history / recap phase) drops out of the join below.
  const pastPrintsBlock =
    cand.phase === "preview" ? renderPastPrintsBlock(intelCtx?.history?.rows ?? []) : "";

  // v5 — the user's own thesis notes + curated bogeys (consensus/whisper).
  const notes = resolveNotesForFamily(snapshot, family);
  const bogeys = resolveBogeysForEvent(snapshot, cand.eventId);
  const notesBlock = renderNotesBlock(notes, cand.symbol);
  const bogeysBlock = renderBogeysBlock(bogeys);

  const sections = [scoreboard, pastPrintsBlock, positionsBlock, bogeysBlock, notesBlock]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");
  return { sections, hasNotes: notes.length > 0, hasBogeys: bogeys.length > 0 };
}

// ── Position resolution from snapshot ─────────────────────────────

export interface PositionView {
  account_name: string;
  symbol: string;
  security_type: string;
  underlying_symbol: string | null;
  option_type: string | null;
  strike_price: number | null;
  expiration_date: string | null;
  multiplier: number | null;
  quantity: number;
  cost_basis: number | null;
  /** Per-share latest price, when known (live IBKR rows carry it; snapshot rows don't). */
  latest_price?: number | null;
}

function resolvePositions(
  snapshot: Snapshot,
  family: readonly string[],
): PositionView[] {
  const holdings = snapshot.holdings ?? [];
  const securities = snapshot.securities ?? [];
  const accounts = snapshot.accounts ?? [];

  const securityById = new Map<number, SecurityRow>();
  for (const s of securities) securityById.set(s.id, s);
  const accountById = new Map<number, AccountRow>();
  for (const a of accounts) accountById.set(a.id, a);

  const familySet = new Set(family.map((s) => s.toUpperCase()));
  const out: PositionView[] = [];
  for (const h of holdings as HoldingRow[]) {
    if (!h.quantity) continue;
    const sec = securityById.get(h.security_id);
    if (!sec) continue;
    const symMatch = sec.symbol && familySet.has(sec.symbol.toUpperCase());
    const underMatch =
      sec.underlying_symbol && familySet.has(sec.underlying_symbol.toUpperCase());
    if (!symMatch && !underMatch) continue;
    const acct = accountById.get(h.account_id);
    out.push({
      account_name: acct?.name ?? `account ${h.account_id}`,
      symbol: sec.symbol ?? "",
      security_type: (sec.security_type ?? "stock").toString(),
      underlying_symbol: sec.underlying_symbol,
      option_type: sec.option_type,
      strike_price: sec.strike_price,
      expiration_date: sec.expiration_date,
      multiplier: sec.multiplier,
      quantity: h.quantity,
      cost_basis: h.cost_basis,
    });
  }
  return out;
}

// ── Recap safety gate (B8) ────────────────────────────────────────────

/** Number(s), guarded to null on non-finite (NaN/Infinity) rather than letting
 * it flow into isPlausibleEarnings — a NaN consensusEps trips the sign-flip
 * check spuriously (Math.sign(NaN) !== Math.sign(anything) is always true).
 * Defense-in-depth: parseFinnhubFigure's eps regex only ever captures valid
 * float syntax today, so eps can't actually produce NaN through the current
 * pipeline, but the revenue capture group ([\d.,]+) is looser and a future
 * regex change could reintroduce the risk on either field. */
function num(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * B8 recap send-decision: (1) actual-required — no actual anywhere means no
 * candidate, never a marker; (2) "at least one real data point" — an
 * implausible actual (isPlausibleEarnings mirror, incl. B19 sign-flip) gets
 * its cells blanked, and if there's no reaction either, the email would be
 * content-free, so skip WITHOUT a marker (stricter than the Mac, which always
 * sends once complete — rationale in the 2026-07-07 B8 spec).
 */
export function evaluateRecapContent(
  event: CalendarEventRow,
  payload: CloudEnrichedPayload | null,
): { send: true; implausible: boolean } | { send: false; reason: "no-actual" | "implausible-no-data-point" } {
  const actualRaw = ((event.actual_value as string | null) ?? payload?.actual) ?? null;
  if (actualRaw == null) return { send: false, reason: "no-actual" };

  const consRaw = effectiveConsensusRaw(event, payload);
  const cons = parseFinnhubFigure(consRaw);
  const act = parseFinnhubFigure(actualRaw);
  // PARITY (Mac: lib/earnings/actuals-display.ts::actualsAreImplausible):
  // a manual_actuals_at stamp means the desk typed this figure in through
  // POST /api/earnings/actuals — an override, never a scrape failure — so
  // the plausibility guard, which exists to catch unattended vendor drift,
  // must not blank it. (The Mac helper tests the stamp for truthiness; the
  // column is only ever written as a timestamp by saveManualActuals, so
  // `!= null` is the same test in practice.) Change both sides together.
  const plausible =
    (event.manual_actuals_at as string | null | undefined) != null ||
    isPlausibleEarnings(
      num(cons.eps),
      num(act.eps),
      num(cons.revenue),
      num(act.revenue),
    );

  // A real data point = at least one reaction delta the scoreboard would
  // actually render, not merely a truthy-but-empty payload (e.g. `{}`) —
  // readReactionDelta is the same defensive reader the scoreboard itself
  // uses, so "has a data point" and "renders a data point" can't diverge.
  const reactionJson =
    (event.reaction_snapshot as string | null) ??
    (payload?.reaction != null ? JSON.stringify(payload.reaction) : null);
  const hasReaction =
    readReactionDelta(reactionJson, "symbol") !== "—" ||
    readReactionDelta(reactionJson, "spy") !== "—" ||
    readReactionDelta(reactionJson, "qqq") !== "—";
  if (!plausible && !hasReaction) return { send: false, reason: "implausible-no-data-point" };
  return { send: true, implausible: !plausible };
}

/**
 * Consensus precedence, single-sourced for BOTH the plausibility gate
 * (evaluateRecapContent) and the rendered table (renderScoreboard): the
 * enrichment-time consensus_value wins, then the same-day cloud-enriched
 * payload's, then the Finnhub-sync-time consensus_estimate. If these two
 * consumers ever drifted, the gate and the table would judge the print
 * against different consensus values — the exact asymmetric-precedence bug
 * class 921d552 fixed on the Mac (renderHeadlineTable consensus precedence).
 */
function effectiveConsensusRaw(
  event: CalendarEventRow,
  payload: CloudEnrichedPayload | null,
): string | null {
  return (
    ((event.consensus_value as string | null) ?? payload?.consensus ?? event.consensus_estimate) ?? null
  );
}

// ── Earnings-intelligence rows (Task 9: snapshot v9 read-only mirror) ──
//
// Row content/format mirrors the Mac's fmtImplied/fmtHistSummary
// (lib/digest/send-earnings-email.ts) exactly, with ONE addition: the
// implied-move cell carries an " — as of <ET time>" suffix, since the cloud
// copy of `computed_at` can be hours (or a day) stale by the time this email
// sends. `intelCtx` is optional/undefined precisely when the R2 snapshot
// predates v9 (earningsIntel/earningsHistory both absent) — in that case the
// two rows are omitted entirely so a pre-v9 snapshot renders byte-identically
// to today. When the snapshot DOES carry v9 fields but this specific event
// has no match (new event, intel not yet computed, no history cached), the
// caller still passes `{ intel: null, history: null }` and the rows render
// with "—" cells — same as the Mac's own no-data behavior.
/** Snapshot intel resolved through the expected-move precedence (sheet >
 * straddle > iv_approx, feedback #5) — `method: "sheet"` carries the winning
 * bogey's label; computedAt/expiryUsed only apply to market-derived methods. */
export interface ResolvedIntelView {
  impliedMovePct: number | null;
  impliedMethod: "sheet" | "straddle" | "iv_approx" | null;
  sheetSourceLabel: string | null;
  expiryUsed: string | null;
  computedAt: string | null;
}

export interface RenderScoreboardIntelCtx {
  intel: ResolvedIntelView | null;
  history: EarningsHistorySnapshotEntry | null;
}

function fmtExpiryShort(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function fmtImplied(intel: ResolvedIntelView | null | undefined): string {
  if (!intel || intel.impliedMovePct == null || !intel.impliedMethod) return "—";
  const pct = intel.impliedMovePct.toFixed(1);
  if (intel.impliedMethod === "sheet") {
    // Analyst-sheet number — no staleness suffix (a curated bogey doesn't
    // decay like options pricing does).
    return `±${pct}% (${intel.sheetSourceLabel ?? "bogey sheet"})`;
  }
  const asOf = intel.computedAt ? ` — as of ${formatEtTimestamp(intel.computedAt)}` : "";
  return intel.impliedMethod === "straddle"
    ? `±${pct}% (straddle, ${fmtExpiryShort(intel.expiryUsed)} exp${asOf})`
    : `~±${pct}% (IV approx${asOf})`;
}

function fmtHistSummary(history: EarningsHistorySnapshotEntry | null | undefined): string {
  const s = history?.summary;
  if (!s || s.avgAbsMovePct == null) return "—";
  const denom = s.beatCount + s.missCount;
  const beat = denom > 0 ? ` · beat ${s.beatCount}/${denom}` : "";
  return `±${s.avgAbsMovePct.toFixed(1)}%${beat}`;
}

// Numeric sibling of readReactionDelta (below) — needed to compare the
// realized move against intel.impliedMovePct, not just format a string.
function readReactionPct(
  json: string | null,
  key: "spy" | "qqq" | "tlt" | "symbol",
): number | null {
  if (!json) return null;
  try {
    const snap = JSON.parse(json) as Record<string, unknown>;
    const node = snap[key] as { delta_pct?: number } | undefined;
    if (!node || node.delta_pct == null) return null;
    const v = Number(node.delta_pct);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic, code-rendered "## Past prints" table — mirrors the Mac's
 * `renderPastPrintsBlock` exactly (lib/digest/send-earnings-email.ts). Preview-
 * only consumer (slotted into the email body right after the scoreboard, same
 * position as the Mac). Returns "" when there's no history yet so callers can
 * splice it in unconditionally without producing an empty section.
 */
export function renderPastPrintsBlock(rows: EarningsHistorySnapshotRow[]): string {
  if (rows.length === 0) return "";
  const sign = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
  const lines = rows.map((h) => {
    const eps = h.epsActual != null && h.epsEstimate != null
      ? `${h.epsActual.toFixed(2)} / ${h.epsEstimate.toFixed(2)}`
      : h.epsActual != null ? h.epsActual.toFixed(2) : "—";
    const surprise = h.surprisePct != null ? sign(h.surprisePct) : "—";
    const move = h.postPrintMovePct != null ? sign(h.postPrintMovePct) : "—";
    return `| ${h.reportedDate} | ${eps} | ${surprise} | ${move} |`;
  });
  return `## Past prints

| Reported | EPS act / est | Surprise | Next-day move |
|---|---|---|---|
${lines.join("\n")}

*Next-day move is close-over-close around the print (public market data; history via Alpha Vantage).*`;
}

// ── Scoreboard table (mirrors Mac renderHeadlineTable) ──────────────

export function renderScoreboard(
  event: CalendarEventRow,
  phase: EarningsPhase,
  payload: CloudEnrichedPayload | null,
  implausible: boolean,
  intelCtx?: RenderScoreboardIntelCtx | null,
): string {
  const cons = parseFinnhubFigure(effectiveConsensusRaw(event, payload));
  // Actual NEVER falls back to consensus_value — that was the
  // estimates-dressed-as-actuals failure 921d552 eliminated on the Mac.
  // Implausible actuals render blanked (⚠ line below the table).
  const actualRaw =
    phase === "recap" ? (((event.actual_value as string | null) ?? payload?.actual) ?? null) : null;
  const actual =
    phase === "recap" && !implausible
      ? parseFinnhubFigure(actualRaw)
      : { eps: null as string | null, revenue: null as string | null };

  const epsConsensus = cons.eps ?? "—";
  const epsActual = actual.eps ?? "—";
  const epsDelta =
    cons.eps && actual.eps && Number.isFinite(Number(cons.eps)) && Number.isFinite(Number(actual.eps))
      ? formatPctDelta(Number(actual.eps), Number(cons.eps))
      : "—";

  const revConsensus = formatRevenue(cons.revenue);
  const revActual = formatRevenue(actual.revenue);
  const revDelta =
    cons.revenue && actual.revenue && Number.isFinite(Number(cons.revenue)) && Number.isFinite(Number(actual.revenue))
      ? formatPctDelta(Number(actual.revenue), Number(cons.revenue))
      : "—";

  const isRecap = phase === "recap";
  const reactionJson =
    ((event.reaction_snapshot as string | null) ??
      (payload?.reaction != null ? JSON.stringify(payload.reaction) : null));
  const stockR = isRecap ? readReactionDelta(reactionJson, "symbol") : "—";
  const spyR = isRecap ? readReactionDelta(reactionJson, "spy") : "—";
  const qqqR = isRecap ? readReactionDelta(reactionJson, "qqq") : "—";

  const phaseLabel = phase === "preview" ? "into the print" : "post-print";
  const sym = event.symbol ?? "";

  const warn = implausible
    ? `\n\n*⚠ Reported actuals were flagged as implausible vs consensus — cells blanked (B19-style basis mismatch or scrape failure). Override via POST /api/earnings/actuals once the Mac is back.*`
    : "";

  // Task 9 (snapshot v9): "Expected move" + "Avg move last 8
  // prints" rows, positioned after Revenue and before Guidance — same slot
  // as the Mac's renderHeadlineTable. `intelCtx === undefined` is the pre-v9
  // signal (snapshot lacks both earningsIntel/earningsHistory entirely) —
  // omit the rows so the scoreboard renders byte-identically to today.
  // `intelCtx` present but `{intel:null, history:null}` (v9 snapshot, no
  // match for this event) still renders the rows with "—" cells.
  let intelRows = "";
  if (intelCtx !== undefined) {
    const impliedCell = fmtImplied(intelCtx?.intel);
    let impliedActual = "—";
    let impliedVerdict = "—";
    if (isRecap && intelCtx?.intel?.impliedMovePct != null) {
      const realized = readReactionPct(reactionJson, "symbol");
      if (realized != null) {
        impliedActual = `${realized >= 0 ? "+" : ""}${realized.toFixed(1)}%`;
        impliedVerdict = Math.abs(realized) <= intelCtx.intel.impliedMovePct ? "inside" : "outside";
      }
    }
    intelRows =
      `\n| **Expected move** | ${impliedCell} | ${impliedActual} | ${impliedVerdict} |` +
      `\n| **Avg move last 8 prints** | ${fmtHistSummary(intelCtx?.history)} | — | — |`;
  }

  return `## ${sym} scoreboard — ${phaseLabel}

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| **EPS** | ${epsConsensus} | ${epsActual} | ${epsDelta} |
| **Revenue** | ${revConsensus} | ${revActual} | ${revDelta} |${intelRows}
| **Guidance (next quarter)** | — | — | — |
| **${sym} @ T+2h** | — | ${stockR} | — |
| **SPY @ T+2h** | — | ${spyR} | — |
| **QQQ @ T+2h** | — | ${qqqR} | — |

*Cloud-fallback delivery — empty cells in a preview are intentional. \`—\` in the actual column on a recap means data wasn't available at send time.*${warn}`;
}

export function renderPositions(
  positions: PositionView[],
  symbol: string,
  family: readonly string[],
  ibkrLive = false,
): string {
  if (positions.length === 0) {
    const src = ibkrLive ? "(IBKR live + snapshot)" : "in the snapshot";
    return `## Positions\nNo current ${family.join("/")} holdings ${src}.`;
  }
  // Presence-only rendering: outbound emails are shared (cc), so NEVER echo an
  // exact cost-basis $. Since 2026-08-02 formatPositionPresence discloses only
  // direction + account + option terms — no counts, no return % (count ×
  // public price reconstructs exact $ exposure).
  const lines = positions.map((p) => {
    const isOption = p.security_type.toLowerCase() === "option";
    const presence = formatPositionPresence({
      symbol: p.symbol.trim(),
      accountName: p.account_name,
      quantity: p.quantity,
      securityType: p.security_type,
      optionMeta: isOption
        ? {
            underlyingSymbol: p.underlying_symbol,
            strikePrice: p.strike_price,
            expirationDate: p.expiration_date,
            optionType: p.option_type,
          }
        : null,
    });
    return `- ${presence}`;
  });

  // Bucket by long/short + stock/option — never net a long against a short
  // (a net-zero-looking sum would hide a hedged or fully-short book). Mirrors
  // the Mac buildPreviewContext accumulation in lib/digest/send-earnings-email.ts.
  let longShares = 0;
  let shortShares = 0;
  let longContracts = 0;
  let shortContracts = 0;
  for (const p of positions) {
    const isOption = p.security_type.toLowerCase() === "option";
    if (isOption) {
      if (p.quantity > 0) longContracts += p.quantity;
      else shortContracts += Math.abs(p.quantity);
    } else {
      if (p.quantity > 0) longShares += p.quantity;
      else shortShares += Math.abs(p.quantity);
    }
  }
  const exposure = formatCombinedExposurePresence({
    positionCount: positions.length,
    longShares,
    shortShares,
    longContracts,
    shortContracts,
  });

  // Provenance: with a live IBKR read, the IBKR rows are current-as-of-send and
  // only the Vanguard/Roth rows are snapshot-frozen — say so, since this email
  // exists precisely because the Mac (and its snapshot) is stale.
  const provenance = ibkrLive
    ? `IBKR live, Vanguard/Roth from snapshot — ${positions.length} row${positions.length === 1 ? "" : "s"}`
    : `snapshot ${positions.length} row${positions.length === 1 ? "" : "s"}`;
  return `## Positions (cross-account, ${provenance})\n${lines.join("\n")}\n\n**Combined exposure:** ${exposure} for ${symbol}.`;
}

/** The snapshot account whose name marks it as the IBKR brokerage (default "IBKR"). */
function resolveIbkrAccountName(snapshot: Snapshot): string {
  const acct = (snapshot.accounts ?? []).find((a) =>
    a.name.toLowerCase().includes("ibkr"),
  );
  return acct?.name ?? "IBKR";
}

function renderNote(
  phase: EarningsPhase,
  ctx: { hasNotes: boolean; hasBogeys: boolean } = { hasNotes: false, hasBogeys: false },
): string {
  // Describe only what's STILL missing, so the note stays honest as the cloud
  // path closes the gap. Bogeys + notes are now mirrored into the v5 snapshot;
  // analyst recs, transcripts, and sell-side web-search remain Mac-only.
  const have: string[] = [];
  if (ctx.hasBogeys) have.push("your curated bogeys (consensus + whisper)");
  if (ctx.hasNotes) have.push("your prior thesis notes");
  const haveLine =
    have.length > 0
      ? `This fallback DOES include ${have.join(" and ")} (mirrored in the nightly snapshot). `
      : "";

  if (phase === "preview") {
    return `## Note — cloud context\n\n${haveLine}Still Mac-only: analyst recommendation trend, prior-quarter transcript context, and sell-side first takes from web search. It ran from the nightly R2 snapshot because the Mac didn't complete this send in time (asleep, unreachable, or its compose failed) — the Mac's next sweep dedups against the cloud-sent marker.`;
  }
  return `## Note — cloud context\n\n${haveLine}The numbers above are from Finnhub + Yahoo bars. Still Mac-only: sell-side first takes from web search, transcript quotes once Motley Fool posts, and analyst commentary.`;
}

// ── v9 context: earnings intelligence from snapshot ─────────────────

/**
 * Resolves the intel-context param `renderScoreboard` expects, straight from
 * the R2 snapshot: `undefined` when the snapshot predates v9 (both fields
 * absent — zero new subrequests, no per-event fetch), otherwise `{intel,
 * history}` with either side `null` when there's no match for this specific
 * event/symbol. History is keyed by upcoming-reporter symbol (uppercased at
 * snapshot-build time on the Mac), matched on `cand.symbol` the same way the
 * rest of this file resolves the event's symbol (no issuer-family widening
 * here — the Mac snapshot script keys earningsHistory by the exact reporting
 * symbol, mirroring how `earnings_intel` is keyed by `event_id`).
 */
function resolveIntelCtx(
  snapshot: Snapshot,
  eventId: number,
  symbol: string,
): RenderScoreboardIntelCtx | undefined {
  if (snapshot.earningsIntel === undefined && snapshot.earningsHistory === undefined) {
    return undefined;
  }
  const raw = (snapshot.earningsIntel ?? []).find((i) => i.eventId === eventId) ?? null;
  // Sheet > straddle > iv_approx (feedback #5): a bogey-sheet expected move
  // outranks the snapshot's market-derived number. Pre-2026-08-03 snapshots
  // lack expected_move_pct on bogey rows — `?? null` degrades to market-only.
  const resolved = resolveExpectedMove({
    bogeys: (snapshot.earningsBogeys ?? [])
      .filter((b) => b.event_id === eventId)
      .map((b) => ({
        expectedMovePct: b.expected_move_pct ?? null,
        sourceLabel: b.source_label,
        uploadedAt: b.uploaded_at,
      })),
    impliedMovePct: raw?.impliedMovePct ?? null,
    impliedMethod: raw?.impliedMethod ?? null,
  });
  const intel: ResolvedIntelView | null = resolved
    ? {
        impliedMovePct: resolved.pct,
        impliedMethod: resolved.method,
        sheetSourceLabel: resolved.method === "sheet" ? resolved.sourceLabel : null,
        expiryUsed: raw?.expiryUsed ?? null,
        computedAt: raw?.computedAt ?? null,
      }
    : null;
  return {
    intel,
    history: snapshot.earningsHistory?.[symbol.toUpperCase()] ?? null,
  };
}

// ── v5 context: notes + bogeys from snapshot ────────────────────────

function resolveNotesForFamily(
  snapshot: Snapshot,
  family: readonly string[],
): SnapshotNote[] {
  const fam = new Set(family.map((s) => s.toUpperCase()));
  return (snapshot.notes ?? []).filter(
    (n) =>
      (n.symbol != null && fam.has(n.symbol.toUpperCase())) ||
      (n.underlying_symbol != null && fam.has(n.underlying_symbol.toUpperCase())),
  );
}

function resolveBogeysForEvent(snapshot: Snapshot, eventId: number): SnapshotBogey[] {
  return (snapshot.earningsBogeys ?? [])
    .filter((b) => b.event_id === eventId)
    // Most recently uploaded first — the Mac composer prefers the latest set.
    .sort((a, b) => (a.uploaded_at < b.uploaded_at ? 1 : -1));
}

const NOTE_CHAR_CAP = 600;

function renderNotesBlock(notes: SnapshotNote[], symbol: string): string {
  if (notes.length === 0) return "";
  const lines = notes.map((n) => {
    const content =
      n.content.length > NOTE_CHAR_CAP ? n.content.slice(0, NOTE_CHAR_CAP) + "…" : n.content;
    const sym = n.symbol ?? symbol;
    const sent = n.sentiment ? ` · ${n.sentiment}` : "";
    const tags = n.tags ? ` · ${n.tags}` : "";
    return `### [${n.event_date}] ${n.note_type} on ${sym}${sent}${tags}\n${content}`;
  });
  return `## Your prior notes on ${symbol} — read these FIRST\n\nYour own journal / earnings / trade-thesis notes on ${symbol} or a sibling-class security. Frame the event against this prior view.\n\n${lines.join("\n\n---\n\n")}`;
}

/** Compact USD for bogey figures (no Mac lib import). 92e9 → "$92.0B". */
function formatBogeyUSD(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `$${Math.round(n).toLocaleString("en-US")}`;
  return `$${n.toFixed(2)}`;
}

function renderBogeysBlock(bogeys: SnapshotBogey[]): string {
  if (bogeys.length === 0) return "";
  const lines = bogeys.map((b, i) => {
    const label = b.source_label ?? `${b.source} (no label)`;
    const fields: string[] = [];
    if (b.eps_consensus != null) fields.push(`EPS consensus ${b.eps_consensus.toFixed(2)}`);
    if (b.eps_whisper != null) fields.push(`EPS **whisper ${b.eps_whisper.toFixed(2)}**`);
    if (b.revenue_consensus_usd != null)
      fields.push(`Rev consensus ${formatBogeyUSD(b.revenue_consensus_usd)}`);
    if (b.revenue_whisper_usd != null)
      fields.push(`Rev **whisper ${formatBogeyUSD(b.revenue_whisper_usd)}**`);
    const head = fields.length > 0 ? `\n${fields.join(" · ")}` : "";
    const guidance = b.guidance_notes ? `\nGuidance: ${b.guidance_notes}` : "";
    const notes = b.notes ? `\nNotes: ${b.notes}` : "";
    return `### [${i + 1}] ${label} (uploaded ${b.uploaded_at})${head}${guidance}${notes}`;
  });
  return `## Bogeys (your curated consensus + whisper — preferred over Finnhub)\n\nWhisper numbers are the bar that matters — beat-the-whisper is the meaningful event. Most recent set first.\n\n${lines.join("\n\n---\n\n")}`;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseFinnhubFigure(s: string | null | undefined): {
  eps: string | null;
  revenue: string | null;
} {
  if (!s) return { eps: null, revenue: null };
  const out: { eps: string | null; revenue: string | null } = { eps: null, revenue: null };
  const epsMatch = /EPS\s+(-?\d+(?:\.\d+)?)/i.exec(s);
  if (epsMatch) out.eps = epsMatch[1];
  const revMatch = /Rev\s+([\d.,]+)/i.exec(s);
  if (revMatch) out.revenue = revMatch[1].replace(/,/g, "");
  return out;
}

function formatRevenue(raw: string | null): string {
  if (!raw) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  return `$${n.toLocaleString()}`;
}

function formatPctDelta(actual: number, consensus: number): string {
  if (consensus === 0) return "—";
  const pct = ((actual - consensus) / Math.abs(consensus)) * 100;
  const abs = Math.abs(pct);
  if (abs < 0.05) return "in-line";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function readReactionDelta(
  json: string | null,
  key: "spy" | "qqq" | "tlt" | "symbol",
): string {
  if (!json) return "—";
  try {
    const snap = JSON.parse(json) as Record<string, unknown>;
    const node = snap[key] as { delta_pct?: number } | undefined;
    if (!node || node.delta_pct == null) return "—";
    const v = Number(node.delta_pct);
    if (!Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  } catch {
    return "—";
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// captureReactionFromYahoo is imported but not used here — the Worker
// fallback reads reaction data from the snapshot's calendar_events row
// (road 1, populated by the Mac's enrichment-runner) AND, since B8, from
// same-day payload.reaction in cloud-enriched KV payloads (road 2 — see the
// KV probe in findCandidatesFromSnapshot). Yahoo capture stays available for
// future use cases where the Worker enriches itself directly.
void captureReactionFromYahoo;
