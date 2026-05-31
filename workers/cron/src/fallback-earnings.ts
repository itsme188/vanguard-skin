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
 *        now+105min ≤ release_instant ≤ now+135min
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
} from "./state";
import { loadLatestSnapshot } from "./state";
import { briefingToHtml } from "./html";
import { sendEmail } from "./resend";
import { composeReleaseInstant } from "./reaction-matcher";
import { captureReactionFromYahoo } from "./yahoo";
import {
  earningsMarkerKey,
  earningsRunningKey,
  readEarningsMarkers,
  writeEarningsMarker,
  type EarningsPhase,
} from "./earnings-markers";

// Issuer-family map mirrored from lib/securities/issuer-family.ts. Worker
// can't cross the Next.js path-alias boundary, so this is a hand copy.
// Keep in sync; new families are slow-moving (rare additions).
const ISSUER_FAMILIES: ReadonlyArray<readonly string[]> = [
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

function issuerSiblings(symbol: string): readonly string[] {
  if (!symbol) return [];
  const fam = FAMILY_BY_SYMBOL.get(symbol.toUpperCase());
  return fam ?? [symbol.toUpperCase()];
}

const PREVIEW_WINDOW_MIN_MS = 105 * 60 * 1000;
const PREVIEW_WINDOW_MAX_MS = 135 * 60 * 1000;
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
      await composeAndSend(env, snapshot, cand);
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
  const auditedSet = new Set(
    (snapshot.earningsEmails ?? []).map((r) => auditKey(r.event_id, r.phase)),
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
): Promise<void> {
  if (!env.BRIEFING_EMAIL_TO) {
    throw new Error("BRIEFING_EMAIL_TO missing");
  }
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    throw new Error("RESEND_API_KEY / RESEND_FROM_DOMAIN missing");
  }

  const family = issuerSiblings(cand.symbol);
  const positions = resolvePositions(snapshot, family);
  const scoreboard = renderScoreboard(cand.event, cand.phase, snapshot, family);
  const positionsBlock = renderPositions(positions, cand.symbol, family);

  const release = cand.event.release_time
    ? ` ${cand.event.release_time} ET`
    : "";
  const phaseLabel = cand.phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const phaseEmoji = cand.phase === "preview" ? "\u{1F50D}" : "\u{1F4CA}";
  const dateLabel = formatDate(cand.event.event_date);
  const title = `${cand.symbol} ${phaseLabel} — ${dateLabel}${release}`;

  const body = `${scoreboard}\n\n${positionsBlock}\n\n${renderNote(cand.phase)}`;
  const footer = `Cloud fallback delivery (state snapshot ${snapshot.snapshotDate}) — Mac was offline. Newsletter bogies, analyst data, prior-call notes are NOT included; the Mac primary version has them.`;
  const html = briefingToHtml(body, title, footer);

  await sendEmail(env, {
    to: env.BRIEFING_EMAIL_TO,
    subject: `${phaseEmoji} ${title}`,
    html,
    fromLocalPart: "earnings",
  });
}

// ── Position resolution from snapshot ─────────────────────────────

interface PositionView {
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
    if (!h.quantity || h.quantity <= 0) continue;
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

function renderPositions(
  positions: PositionView[],
  symbol: string,
  family: readonly string[],
): string {
  if (positions.length === 0) {
    return `## Positions\nNo current ${family.join("/")} holdings in the snapshot.`;
  }
  const lines = positions.map((p) => {
    if (p.security_type.toLowerCase() === "option") {
      const right = p.option_type ? p.option_type.toUpperCase().charAt(0) : "?";
      const strike = p.strike_price != null ? `$${p.strike_price.toFixed(2)}` : "?";
      const expiry = p.expiration_date ?? "?";
      const mult = p.multiplier ?? 100;
      const cost = p.cost_basis != null ? `$${p.cost_basis.toFixed(2)}` : "?";
      return `- **${p.underlying_symbol ?? "?"} ${expiry} ${right}${strike}** option (${p.symbol.trim()}) in ${p.account_name}: ${p.quantity} contract(s) — ${p.quantity * mult} shares notional × ${mult}, total cost ${cost}`;
    }
    const blended = p.cost_basis != null && p.quantity > 0
      ? `$${(p.cost_basis / p.quantity).toFixed(2)}`
      : "?";
    const cost = p.cost_basis != null ? `$${p.cost_basis.toFixed(2)}` : "?";
    return `- **${p.symbol}** in ${p.account_name}: ${p.quantity} sh, cost basis ${cost} (~${blended}/sh)`;
  });

  const shares = positions.filter((p) => p.security_type.toLowerCase() !== "option").reduce((s, p) => s + p.quantity, 0);
  const contracts = positions.filter((p) => p.security_type.toLowerCase() === "option").reduce((s, p) => s + p.quantity, 0);
  const summaryParts: string[] = [];
  if (shares > 0) summaryParts.push(`${shares.toFixed(0)} shares`);
  if (contracts > 0) summaryParts.push(`${contracts.toFixed(0)} option contract(s)`);

  return `## Positions (cross-account, snapshot ${positions.length} row${positions.length === 1 ? "" : "s"})\n${lines.join("\n")}\n\n**Combined exposure:** ${summaryParts.join(" + ") || "none"} for ${symbol}.`;
}

function renderNote(phase: EarningsPhase): string {
  if (phase === "preview") {
    return `## Note — limited cloud context\n\nThe Mac primary path generates a richer preview with TMT Breakout / Vital Knowledge / Eliant / Purple Drink / Meisler bogies, analyst recommendation trend, prior-quarter transcript context, and any of your own thesis notes. None of that is in this fallback — it ran from the nightly R2 snapshot because the Mac was unreachable. Treat this as a numbers-only heads-up; the rich version will arrive once the Mac is back online (or skip — the next launchd tick will dedup against the cloud-sent marker).`;
  }
  return `## Note — limited cloud context\n\nThe Mac primary path generates a richer recap with sell-side first takes from web search, transcript quotes once Motley Fool posts, and ties back to your prior thesis notes. None of that is in this fallback — it ran from the nightly R2 snapshot because the Mac was unreachable. The numbers above are from Finnhub + Yahoo bars; the line-by-line bogies + analyst commentary live in the Mac version.`;
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
