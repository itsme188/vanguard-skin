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
// section). Recap window is untouched — its 4h band already gives ample
// Mac-first berth.
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
  const candidates = findCandidatesFromSnapshot(snapshot, now);
  result.swept = candidates.length;

  if (candidates.length === 0) return result;

  // Tier 3 — live IBKR refresh. The snapshot's IBKR rows can be days stale while
  // the Mac is asleep (travel), so an earnings email might show a position the
  // user has since exited or resized. Pull the current book ONCE for the whole
  // run (one LST mint, reused across candidates). Best-effort: any failure
  // degrades to the snapshot positions. Never run on dry-run (no network).
  let liveIbkr: LiveIbkrPosition[] | null = null;
  const ibkrAccountName = resolveIbkrAccountName(snapshot);
  if (!opts.dryRun) {
    const ibkrCfg = ibkrConfigFromEnv(
      env as unknown as Record<string, string | undefined>,
    );
    if (ibkrCfg) {
      try {
        liveIbkr = await fetchLiveIbkrPositionsCached(env.CRON_KV, ibkrCfg);
        console.log(`[fallback-earnings] live IBKR refresh: ${liveIbkr.length} positions`);
      } catch (err) {
        console.warn("[fallback-earnings] live IBKR refresh failed, using snapshot:", err);
      }
    }
  }

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
      await composeAndSend(env, snapshot, cand, liveIbkr, ibkrAccountName);
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

function findCandidatesFromSnapshot(
  snapshot: Snapshot,
  now: Date,
): SnapshotCandidate[] {
  const nowMs = now.getTime();
  const heldSet = new Set(snapshot.heldSymbols.map((s) => s.toUpperCase()));
  const muted = new Set(snapshot.earningsSettings?.mutedSymbols ?? []);
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

  for (const e of snapshot.calendarEvents) {
    if (e.event_type !== "earnings") continue;
    if (!e.symbol) continue;
    const sym = e.symbol.toUpperCase();
    if (!heldSet.has(sym)) continue; // held-only — Worker doesn't have watchlist data yet
    if (muted.has(sym)) continue;

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

    // Recap candidate
    const enrichedAt = (e as Record<string, unknown>).enriched_at as string | null | undefined;
    if (enrichedAt && !auditedSet.has(auditKey(e.id, "recap"))) {
      const enrichedMs = Date.parse(enrichedAt.replace(" ", "T") + "Z");
      if (Number.isFinite(enrichedMs)) {
        const ageMs = nowMs - enrichedMs;
        if (ageMs >= 0 && ageMs <= RECAP_WINDOW_MAX_MS) {
          out.push({ eventId: e.id, symbol: sym, phase: "recap", event: e });
        }
      }
    }
  }

  return out;
}

async function composeAndSend(
  env: FallbackEnv,
  snapshot: Snapshot,
  cand: SnapshotCandidate,
  liveIbkr: LiveIbkrPosition[] | null,
  ibkrAccountName: string,
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
  const scoreboard = renderScoreboard(cand.event, cand.phase, snapshot, family);
  const positionsBlock = renderPositions(positions, cand.symbol, family, liveIbkr !== null);

  // v5 — the user's own thesis notes + curated bogeys (consensus/whisper).
  // These are the cheaply-mirrorable parts of the Mac's rich context, so the
  // cloud email is no longer purely "numbers only".
  const notes = resolveNotesForFamily(snapshot, family);
  const bogeys = resolveBogeysForEvent(snapshot, cand.eventId);
  const notesBlock = renderNotesBlock(notes, cand.symbol);
  const bogeysBlock = renderBogeysBlock(bogeys);

  const release = cand.event.release_time
    ? ` ${cand.event.release_time} ET`
    : "";
  const phaseLabel = cand.phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const phaseEmoji = cand.phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
  const dateLabel = formatDate(cand.event.event_date);
  const title = `${cand.symbol} ${phaseLabel} — ${dateLabel}${release}`;

  // Bogeys (curated consensus/whisper) and the user's prior notes slot between
  // the scoreboard and the limited-context note, mirroring the Mac composer's
  // ordering. Empty blocks drop out.
  const body = [
    scoreboard,
    positionsBlock,
    bogeysBlock,
    notesBlock,
    renderNote(cand.phase, { hasNotes: notes.length > 0, hasBogeys: bogeys.length > 0 }),
  ]
    .filter((s) => s && s.trim().length > 0)
    .join("\n\n");

  const included: string[] = [];
  if (bogeys.length > 0) included.push("your curated bogeys");
  if (notes.length > 0) included.push("your prior notes");
  const includedNote =
    included.length > 0 ? ` ${included.join(" + ")} ARE included above.` : "";
  const footer = `Cloud fallback delivery (state snapshot ${snapshot.snapshotDate}) — Mac was offline.${includedNote} Analyst recs, transcripts, and sell-side web-search are only in the Mac primary version.`;
  const html = briefingToHtml(body, title, footer);

  await sendEmail(env, {
    to: env.BRIEFING_EMAIL_TO,
    subject: `${phaseEmoji} ${title}`,
    html,
    fromLocalPart: "earnings",
  });
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

// ── Scoreboard table (mirrors Mac renderHeadlineTable) ──────────────

function renderScoreboard(
  event: CalendarEventRow,
  phase: EarningsPhase,
  _snapshot: Snapshot,
  _family: readonly string[],
): string {
  const cons = parseFinnhubFigure(event.consensus_estimate);
  const actual = phase === "recap"
    ? parseFinnhubFigure((event.actual_value ?? event.consensus_value ?? null) as string | null)
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
  const reactionJson = (event.reaction_snapshot ?? null) as string | null;
  const stockR = isRecap ? readReactionDelta(reactionJson, "symbol") : "—";
  const spyR = isRecap ? readReactionDelta(reactionJson, "spy") : "—";
  const qqqR = isRecap ? readReactionDelta(reactionJson, "qqq") : "—";

  const phaseLabel = phase === "preview" ? "into the print" : "post-print";
  const sym = event.symbol ?? "";

  return `## ${sym} scoreboard — ${phaseLabel}

| Metric | Consensus | Actual | Δ |
|---|---|---|---|
| **EPS** | ${epsConsensus} | ${epsActual} | ${epsDelta} |
| **Revenue** | ${revConsensus} | ${revActual} | ${revDelta} |
| **Guidance (next quarter)** | — | — | — |
| **${sym} @ T+2h** | — | ${stockR} | — |
| **SPY @ T+2h** | — | ${spyR} | — |
| **QQQ @ T+2h** | — | ${qqqR} | — |

*Cloud-fallback delivery — empty cells in a preview are intentional. \`—\` in the actual column on a recap means data wasn't available at send time.*`;
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
  // exact cost-basis $. formatPositionPresence discloses share/contract count +
  // direction + a relative return % (when a price is known), with no $ exposure.
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
            multiplier: p.multiplier,
          }
        : null,
      costBasis: p.cost_basis,
      latestPrice: p.latest_price ?? null,
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
    return `## Note — cloud context\n\n${haveLine}Still Mac-only: analyst recommendation trend, prior-quarter transcript context, and sell-side first takes from web search. It ran from the nightly R2 snapshot because the Mac was unreachable — the fuller version will arrive once the Mac is back online (or skip; the next launchd tick dedups against the cloud-sent marker).`;
  }
  return `## Note — cloud context\n\n${haveLine}The numbers above are from Finnhub + Yahoo bars. Still Mac-only: sell-side first takes from web search, transcript quotes once Motley Fool posts, and analyst commentary.`;
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
// fallback reads reaction from the snapshot's calendar_events row which
// the Mac's enrichment-runner already populates. Yahoo capture stays
// available for future use cases where the Worker enriches itself.
void captureReactionFromYahoo;
