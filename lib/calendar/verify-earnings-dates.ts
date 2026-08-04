import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { getSymbolStatus } from "@/lib/queries/briefing-symbols";
import { getReadThroughReporterSymbols } from "@/lib/queries/read-through-pairs";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { extractJsonArray } from "@/lib/ai/extract-json";
import { correctEarningsEventDate } from "@/lib/mutations/calendar";
import { getRawAnthropicClient } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { sendPushover } from "@/lib/alerts/notify-pushover";
import {
  EARLIEST_PLAUSIBLE_ET,
  LATEST_PLAUSIBLE_ET,
  hasBoundedObservations,
  getSymbolReleaseTimeRow,
  upsertSymbolReleaseTime,
  applyResolvedReleaseTimeToUpcomingEvents,
} from "@/lib/earnings/wire-times";

/**
 * Earnings date/slot verification — candidate selection, prompt building,
 * verdict parsing (pure, Task 3) plus apply semantics + the orchestrator
 * (Task 4) for upcoming held/watchlist/read-through-reporter earnings whose
 * vendor-sourced date (Finnhub/Nasdaq/WSH) has never been independently
 * confirmed.
 *
 * applyVerdict is pure DB — no AI calls. runEarningsDateVerification is the
 * only network-calling entry point, and it goes through the fetchVerdicts DI
 * seam so it's fully testable without hitting Anthropic.
 */

const DEFAULT_HORIZON_DAYS = 7;
const DEFAULT_LIMIT = 25;
// The orchestrator passes this explicitly rather than relying on
// findDateVerificationCandidates' own default (25) — a daily verification
// pass budgets a handful of AI calls, not the whole horizon at once.
const DEFAULT_VERIFICATION_LIMIT = 8;
// A confirmed_date this far past today is not "the next quarterly print" —
// it's a hallucinated placeholder. Wide enough to absorb a genuine multi-week
// slip (a company moving from early to late in its reporting window) without
// admitting next quarter's date.
const MAX_CONFIRMED_DATE_LOOKAHEAD_DAYS = 37;

// ── Daily gate ───────────────────────────────────────────────────────────
const DAILY_GATE_SETTINGS_KEY = "earnings_date_verify_last_run";
// BMO earnings-preview emails start firing ~06:25 ET (the [105,135]-min
// preview window off an early release_time) — verification of an incoming
// wrong date/slot must land before that window opens, so the gate opens at
// 05:00 ET, comfortably ahead of the first preview send.
const DAILY_GATE_OPEN_HOUR_ET = 5;

export interface DateVerificationCandidate {
  id: number;
  symbol: string;
  event_date: string;
  event_time: string | null;
  release_time: string | null;
  source: string;
}

export interface DateVerdict {
  symbol: string;
  confirmed_date: string | null; // YYYY-MM-DD
  slot: "bmo" | "amc" | null;
  confidence: "confirmed" | "unconfirmed";
  source: string | null;
  exact_time: string | null; // "HH:MM" ET, only requested for flagged symbols
}

/**
 * Selects upcoming earnings rows worth verifying: held, watchlisted, or a
 * read-through reporter symbol (its print matters even though the user
 * doesn't own it directly) — with an unconfirmed date within the horizon.
 *
 * SQL pre-filters on what it can see cheaply (type, supersede/verify/actual
 * state, date range); held/watchlist/reporter status requires a DB round
 * trip per symbol batch, so that filter runs in JS via getSymbolStatus.
 *
 * Family-dedupes dual-class share symbols (GOOG/GOOGL) down to one row —
 * they're the same earnings print, verifying both would waste an AI call and
 * could produce two diverging verdicts for one company. Rows arrive from SQL
 * already ordered event_date ASC, id ASC, so "keep the first occurrence per
 * family" naturally keeps the earliest-date/earliest-id row.
 *
 * `source = 'manual'` rows are NEVER candidates: manual rows are exclusively
 * user-authored (the "+ Add ticker" flow) or verifier-authored corrections,
 * and neither wants an AI second-guessing the date the user just set. The
 * accepted consequence is that a corrected row is not re-verified later —
 * including by the near-print re-open below. That is deliberate: the
 * correction already carries a confirmed source, and an adopted vendor row
 * (see correctEarningsEventDate) stays eligible anyway.
 *
 * Near-print re-open: a stamped row is normally excluded forever, but the
 * stamp often records "unconfirmed — no announcement yet" from a T-7 pass,
 * while the IR announcement typically exists by T-2 (the OCUL shape). So a
 * row whose print is within 2 days re-enters candidacy once its last
 * verification is more than 2 days old — one extra look right where it
 * matters, without re-spending on the whole horizon daily.
 */
export function findDateVerificationCandidates(
  db: Database.Database,
  opts?: { now?: Date; horizonDays?: number; limit?: number },
): DateVerificationCandidate[] {
  const today = todayET(opts?.now);
  const horizon = addDays(today, opts?.horizonDays ?? DEFAULT_HORIZON_DAYS);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const rows = db
    .prepare(
      `SELECT ce.id, ce.symbol, ce.event_date, ce.event_time, ce.release_time, ce.source
         FROM calendar_events ce
        WHERE ce.event_type = 'earnings'
          AND COALESCE(ce.superseded, 0) = 0
          AND ce.symbol IS NOT NULL
          AND ce.actual_value IS NULL
          AND ce.source != 'manual'
          AND (
            ce.date_verified_at IS NULL
            OR (ce.event_date <= date(?, '+2 days')
                AND datetime(ce.date_verified_at) <= datetime('now', '-2 days'))
          )
          AND ce.event_date BETWEEN ? AND ?
        ORDER BY ce.event_date ASC, ce.id ASC`,
    )
    .all(today, today, horizon) as DateVerificationCandidate[];

  if (rows.length === 0) return [];

  const reporterSet = new Set(getReadThroughReporterSymbols(db).map((s) => s.toUpperCase()));
  const status = getSymbolStatus(
    db,
    rows.map((r) => r.symbol),
  );

  const covered = rows.filter((r) => {
    const u = r.symbol.toUpperCase();
    return status[u] === "held" || status[u] === "watchlist" || reporterSet.has(u);
  });

  const seenFamilies = new Set<string>();
  const deduped: DateVerificationCandidate[] = [];
  for (const c of covered) {
    const familyKey = issuerSiblings(c.symbol.toUpperCase())
      .map((s) => s.toUpperCase())
      .slice()
      .sort()
      .join(",");
    if (seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);
    deduped.push(c);
  }

  return deduped.slice(0, limit);
}

/**
 * Resolves the BMO/AMC slot a candidate's date should be verified against.
 * event_time carries the vendor's own BMO/AMC marker (preferred, case-
 * insensitive); when it's absent OR an unrecognized value (e.g. "TAS"),
 * falls back to release_time's clock hour (before noon ET → bmo, noon or
 * later → amc). Null when neither resolves to a slot.
 */
export function effectiveSlot(c: {
  event_time: string | null;
  release_time: string | null;
}): "bmo" | "amc" | null {
  const et = c.event_time?.trim().toUpperCase();
  if (et === "BMO") return "bmo";
  if (et === "AMC") return "amc";

  const rt = c.release_time;
  if (rt && /^\d{2}:\d{2}/.test(rt)) {
    const hour = parseInt(rt.slice(0, 2), 10);
    if (!Number.isNaN(hour)) return hour < 12 ? "bmo" : "amc";
  }

  return null;
}

export function buildDateVerificationPrompt(
  candidates: DateVerificationCandidate[],
  todayStr: string,
  needTimeSymbols?: Set<string>,
): string {
  const flagged = needTimeSymbols ?? new Set<string>();
  const lines = candidates.map((c) => {
    const slot = effectiveSlot(c) ?? "unknown slot";
    const suffix = flagged.has(c.symbol) ? " (also find the exact expected report time)" : "";
    return `- ${c.symbol} — vendor says ${c.event_date}, ${slot}${suffix}`;
  });

  const schemaLine =
    flagged.size > 0
      ? `[{"symbol":"XYZ","confirmed_date":"YYYY-MM-DD","slot":"bmo","confidence":"confirmed","source":"<url or short citation>","exact_time":"HH:MM"}]`
      : `[{"symbol":"XYZ","confirmed_date":"YYYY-MM-DD","slot":"bmo","confidence":"confirmed","source":"<url or short citation>"}]`;

  const exactTimeRule =
    flagged.size > 0
      ? ` For symbols marked "(also find the exact expected report time)", also report "exact_time" as the expected wall-clock ET time of the press release in 24h "HH:MM" (e.g. "07:05"). EarningsWhispers (earningswhispers.com) is the preferred source for expected report times; a company IR announcement or prior-quarter BusinessWire timestamps also count. If you cannot find a specific time, set "exact_time" to null — NEVER guess one.`
      : "";

  return `You are verifying upcoming earnings report dates. Today is ${todayStr}.

For EACH company below, find the CONFIRMED date and timing of its next quarterly earnings report. Prefer the company's own investor-relations announcement or press release ("X to report results on ..."). A wire story or two agreeing independent calendars also count as confirmation. bmo = before the market opens, amc = after the market closes.

The vendor date/slot shown may be WRONG — that is why you are verifying. Do not assume it is right.

Candidates:
${lines.join("\n")}

Respond ONLY with a JSON array, one object per candidate symbol, no prose:
${schemaLine}

Rules: "confidence":"confirmed" ONLY with an explicit company announcement or two agreeing independent sources. If you cannot confirm, use "confidence":"unconfirmed" and set "confirmed_date" to your best finding or null. NEVER invent a date.${exactTimeRule}`;
}

function normalizeVerdict(raw: unknown): DateVerdict | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.symbol !== "string" || r.symbol.trim() === "") return null;

  let confirmed_date: string | null;
  if (r.confirmed_date === null || r.confirmed_date === undefined) {
    confirmed_date = null;
  } else if (typeof r.confirmed_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.confirmed_date)) {
    confirmed_date = r.confirmed_date;
  } else {
    return null; // malformed date shape
  }

  let slot: "bmo" | "amc" | null;
  if (r.slot === null || r.slot === undefined) {
    slot = null;
  } else if (typeof r.slot === "string" && ["bmo", "amc"].includes(r.slot.toLowerCase())) {
    slot = r.slot.toLowerCase() as "bmo" | "amc";
  } else {
    return null; // unknown slot
  }

  const confidence: "confirmed" | "unconfirmed" = r.confidence === "confirmed" ? "confirmed" : "unconfirmed";
  const source = typeof r.source === "string" ? r.source : null;

  let exact_time: string | null = null;
  if (
    typeof r.exact_time === "string" &&
    /^\d{2}:\d{2}$/.test(r.exact_time) &&
    r.exact_time >= EARLIEST_PLAUSIBLE_ET &&
    r.exact_time <= LATEST_PLAUSIBLE_ET
  ) {
    exact_time = r.exact_time;
  }

  return { symbol: r.symbol.trim(), confirmed_date, slot, confidence, source, exact_time };
}

/**
 * Parses the AI's JSON-array response into verdicts, applying both mandated
 * LLM-JSON defenses (see CLAUDE.md): extractJsonArray for a prose preamble,
 * then a retry with C0 control chars collapsed to spaces for raw unescaped
 * newlines inside string literals (JSON.parse's "Bad control character").
 * Malformed entries (bad date shape, unrecognized slot, missing symbol) are
 * dropped rather than throwing — one bad entry must not sink the batch.
 */
export function parseDateVerdicts(text: string): DateVerdict[] {
  const json = extractJsonArray(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    try {
      parsed = JSON.parse(json.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      throw err;
    }
  }

  if (!Array.isArray(parsed)) return [];

  const out: DateVerdict[] = [];
  for (const item of parsed) {
    const v = normalizeVerdict(item);
    if (v) out.push(v);
  }
  return out;
}

// ─── Apply semantics ────────────────────────────────────────────────────────

export type VerificationAction =
  | "verified"
  | "date-corrected"
  | "slot-corrected"
  | "unverifiable"
  | "refused";

export interface VerificationOutcome {
  candidate: DateVerificationCandidate;
  action: VerificationAction;
  detail: string;
}

/**
 * Applies a single verdict to a single candidate row. Pure DB — no AI calls.
 *
 * Apply-semantics matrix (see docs/superpowers/sdd/2026-08-02-earnings-date-verification):
 *   - no verdict OR confirmed_date null → stamp "unverifiable — <source|no source found>"
 *   - confirmed_date outside [today, today+MAX_CONFIRMED_DATE_LOOKAHEAD_DAYS]
 *                                       → stamp "implausible confirmed_date ..." (never corrects)
 *   - confidence !== "confirmed"        → stamp "unconfirmed — left as vendor date (...)"
 *   - date equal + slot agrees/unknown  → stamp "confirmed via <source>", action "verified"
 *   - date equal + slot differs         → correctEarningsEventDate (same date, new slot),
 *                                          stamp the NEW row, action "slot-corrected"
 *   - date differs                      → correctEarningsEventDate (new date [+ slot]),
 *                                          stamp the NEW row, action "date-corrected"
 *   - correctEarningsEventDate refuses  → action "refused", nothing stamped
 *
 * `opts.apply: false` is a dry run: every outcome is computed exactly as it
 * would be applied, but nothing is written — neither the date_verified_at /
 * date_verification_note stamp nor a correctEarningsEventDate call (which has
 * no dry-run mode of its own, so a dry run must never call it at all).
 */
export function applyVerdict(
  db: Database.Database,
  candidate: DateVerificationCandidate,
  verdict: DateVerdict | undefined,
  opts: { apply: boolean; today?: string },
): VerificationOutcome {
  const stamp = (note: string, eventId: number): void => {
    if (!opts.apply) return;
    db.prepare(
      `UPDATE calendar_events SET date_verified_at = datetime('now'), date_verification_note = ? WHERE id = ?`,
    ).run(note, eventId);
  };

  if (!verdict || verdict.confirmed_date === null) {
    const note = `unverifiable — ${verdict?.source ?? "no source found"}`;
    stamp(note, candidate.id);
    return { candidate, action: "unverifiable", detail: note };
  }

  // Sanity bound BEFORE any branch that trusts the verdict. A model that
  // surfaces last quarter's print (a past date) or a placeholder a year out
  // would otherwise move a live earnings row onto a date nothing else agrees
  // with — and the move is destructive (the old row is suppressed). Out of
  // bounds is treated exactly like an unconfirmed verdict: stamped so the
  // pass isn't re-spent daily, never corrected.
  const today = opts.today ?? todayET();
  const latestPlausible = addDays(today, MAX_CONFIRMED_DATE_LOOKAHEAD_DAYS);
  if (verdict.confirmed_date < today || verdict.confirmed_date > latestPlausible) {
    const note =
      `implausible confirmed_date ${verdict.confirmed_date} — treated as unconfirmed ` +
      `(outside ${today}..${latestPlausible})`;
    stamp(note, candidate.id);
    return { candidate, action: "unverifiable", detail: note };
  }

  if (verdict.confidence !== "confirmed") {
    const note = `unconfirmed — left as vendor date (${verdict.confirmed_date ?? "?"} ${verdict.slot ?? "?"} suggested)`;
    stamp(note, candidate.id);
    return { candidate, action: "unverifiable", detail: note };
  }

  const candidateSlot = effectiveSlot(candidate);
  const dateEqual = verdict.confirmed_date === candidate.event_date;
  const source = verdict.source ?? "web";

  if (dateEqual) {
    if (verdict.slot !== null && candidateSlot !== null && verdict.slot !== candidateSlot) {
      // Both sides resolve to a slot and they disagree — same-date slot fix.
      const note = `slot corrected ${candidateSlot}→${verdict.slot} via ${source}`;
      if (!opts.apply) return { candidate, action: "slot-corrected", detail: note };

      const result = correctEarningsEventDate(db, {
        symbol: candidate.symbol,
        wrongDate: candidate.event_date,
        correctDate: candidate.event_date,
        slot: verdict.slot.toUpperCase() as "BMO" | "AMC",
      });
      if (!result.ok || !result.newEventId) {
        return {
          candidate,
          action: "refused",
          detail: result.refusedReason ?? "correction returned no corrected event id",
        };
      }
      stamp(note, result.newEventId);
      return { candidate, action: "slot-corrected", detail: note };
    }

    // Slot equal, or either side has no resolvable slot — confirmed as-is.
    const note = `confirmed via ${source}`;
    stamp(note, candidate.id);
    return { candidate, action: "verified", detail: note };
  }

  // Date differs — correct it, carrying the verdict's slot when it has one.
  const note = `date corrected ${candidate.event_date}→${verdict.confirmed_date} via ${source}`;
  if (!opts.apply) return { candidate, action: "date-corrected", detail: note };

  const result = correctEarningsEventDate(db, {
    symbol: candidate.symbol,
    wrongDate: candidate.event_date,
    correctDate: verdict.confirmed_date,
    slot: verdict.slot ? (verdict.slot.toUpperCase() as "BMO" | "AMC") : undefined,
  });
  if (!result.ok || !result.newEventId) {
    return {
      candidate,
      action: "refused",
      detail: result.refusedReason ?? "correction returned no corrected event id",
    };
  }
  stamp(note, result.newEventId);
  return { candidate, action: "date-corrected", detail: note };
}

// ─── Exact-time jump-start (2026-08-04 wire-time spec, Task 4) ─────────────
//
// The wire-time cascade (lib/earnings/wire-times.ts) already resolves a
// per-symbol release time from bounded first-seen observations once a couple
// of quarters have been watched — but a symbol the system has never seen
// print has no observations yet. Rather than wait a full quarter to learn a
// new symbol's slot from scratch, the daily date-verification pass (which
// already spends an AI call with web_search per candidate) piggybacks one
// extra ask: find the EXACT expected report time via EarningsWhispers (the
// same source the wire-time spec treats as authoritative), so newly-held or
// newly-watchlisted symbols get a real time immediately instead of the
// generic 08:00/16:15 BMO/AMC default.

/**
 * True when `symbol` still needs an exact-time lookup for `eventDate`:
 *   - a bounded wire observation already exists → the cascade has direct
 *     evidence, an AI-sourced time would be redundant (and could regress it).
 *   - a standing user override exists → never second-guess an explicit user
 *     decision.
 *   - a web_verified row exists whose verified_for_date already covers this
 *     print (>= eventDate) → still fresh, no need to re-ask.
 * Otherwise (no override, no bounded observations, or a STALE web row
 * verified for an earlier print) → true.
 */
export function needsExactTime(
  db: Database.Database,
  symbol: string,
  eventDate: string,
): boolean {
  if (hasBoundedObservations(db, symbol)) return false;
  const row = getSymbolReleaseTimeRow(db, symbol);
  if (row?.source === "user") return false;
  if (row?.source === "web_verified" && row.verified_for_date && row.verified_for_date >= eventDate) {
    return false;
  }
  return true;
}

/**
 * Applies a verdict's `exact_time` (when present and in-range) as a
 * web_verified symbol_release_times row, then re-resolves any untouched
 * upcoming earnings rows for the symbol's issuer family so the new time takes
 * effect immediately (not just on the next enrichment pass).
 *
 * Independent of applyVerdict's date/slot correction — a verdict can carry a
 * confirmed exact_time even when the date itself was already correct (the
 * common case: date verification only asks about NEW symbols' dates when
 * unverified, but the exact-time ask piggybacks regardless of the date
 * outcome for any symbol flagged by needsExactTime).
 *
 * Never overwrites a standing 'user' override (belt-and-braces on top of
 * upsertSymbolReleaseTime's own precedence guard against 'user' rows — see
 * Task 2). Rejects an out-of-range or malformed time (defense in depth on
 * top of normalizeVerdict's own regex+range guard, since callers could in
 * principle construct a DateVerdict by hand).
 */
export function applyExactTimeVerdict(
  db: Database.Database,
  verdict: DateVerdict,
  candidate: DateVerificationCandidate,
): boolean {
  const t = verdict.exact_time;
  if (!t || !/^\d{2}:\d{2}$/.test(t)) return false;
  if (t < EARLIEST_PLAUSIBLE_ET || t > LATEST_PLAUSIBLE_ET) return false;
  const existing = getSymbolReleaseTimeRow(db, verdict.symbol);
  if (existing?.source === "user") return false;
  upsertSymbolReleaseTime(db, {
    symbol: verdict.symbol,
    releaseTime: t,
    source: "web_verified",
    note: verdict.source ? `verified via ${verdict.source}` : "date-verification pass",
    verifiedForDate: verdict.confirmed_date ?? candidate.event_date,
  });
  applyResolvedReleaseTimeToUpcomingEvents(db, verdict.symbol);
  return true;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Default Claude + native web_search fetcher — mirrors
 * lib/securities/verify-sector-tags.ts::defaultFetchVerdicts exactly (same
 * provider guard, same tool block, same model-id derivation via
 * resolveFeatureModel(featureKey)). Never called in tests (they always
 * inject fetchVerdicts).
 */
export async function defaultFetchDateVerdicts(prompt: string): Promise<string> {
  const featureKey = "earningsDateVerification";
  const { provider, modelId } = resolveFeatureModel(featureKey);
  if (provider !== "anthropic") {
    throw new Error(
      `Earnings date verification requires the Anthropic provider for native web_search; FEATURE_MODELS["${featureKey}"] resolves to ${provider}/${modelId}. Update lib/ai/models.ts.`,
    );
  }
  const client = getRawAnthropicClient(featureKey);

  const response = await client.messages.create({
    model: modelId,
    max_tokens: 4000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    messages: [{ role: "user", content: prompt }],
  });
  const textBlocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return textBlocks.map((b) => b.text).join("\n");
}

/**
 * Orchestrates a full verification pass: candidates → prompt → AI fetch →
 * parse → applyVerdict per candidate → (on real corrections) one Pushover
 * summary.
 *
 * Verdict matching is family-aware: the AI may answer with a different
 * share-class symbol than the one the candidate carries (e.g. a "GOOGL"
 * verdict for a "GOOG" candidate) — matched via issuerSiblings, not a bare
 * string comparison.
 *
 * Never throws into its caller — this is meant to run from a cron-style
 * driver where a bad AI response or a transient network error must not sink
 * the whole job. Whatever outcomes were computed before a failure are
 * returned as-is.
 *
 * `apply` is REQUIRED, deliberately: this function deletes and suppresses
 * calendar rows, so "did the caller mean to write?" must never be answered by
 * a default. Every call site states its intent (the CLI from its --apply
 * flag, the daily gate with a literal true).
 */
export async function runEarningsDateVerification(
  db: Database.Database,
  opts: {
    apply: boolean;
    now?: Date;
    limit?: number;
    fetchVerdicts?: (prompt: string) => Promise<string>;
  },
): Promise<{ outcomes: VerificationOutcome[]; corrections: number }> {
  const outcomes: VerificationOutcome[] = [];
  const countCorrections = () =>
    outcomes.filter((o) => o.action === "date-corrected" || o.action === "slot-corrected").length;

  try {
    const limit = opts.limit ?? DEFAULT_VERIFICATION_LIMIT;
    const candidates = findDateVerificationCandidates(db, { now: opts.now, limit });
    if (candidates.length === 0) return { outcomes, corrections: 0 };

    const today = todayET(opts.now);
    // Symbols whose release time is still unresolved (no bounded observation
    // history, no standing override, no fresh web-sourced note) — these get
    // an extra ask in the same prompt/AI call (see needsExactTime).
    const needTime = new Set(
      candidates.filter((c) => needsExactTime(db, c.symbol, c.event_date)).map((c) => c.symbol),
    );
    const prompt = buildDateVerificationPrompt(candidates, today, needTime);
    const fetcher = opts.fetchVerdicts ?? defaultFetchDateVerdicts;

    const text = await fetcher(prompt);
    const verdicts = parseDateVerdicts(text);

    const verdictBySymbol = new Map<string, DateVerdict>();
    for (const v of verdicts) verdictBySymbol.set(v.symbol.toUpperCase(), v);

    for (const candidate of candidates) {
      const family = issuerSiblings(candidate.symbol.toUpperCase()).map((s) => s.toUpperCase());
      const verdict = family.map((sym) => verdictBySymbol.get(sym)).find((v) => v !== undefined);
      outcomes.push(applyVerdict(db, candidate, verdict, { apply: opts.apply, today }));
    }

    // Exact-time application is independent of the date/slot outcome above —
    // respects the same apply flag: dry-run only logs what would be stored,
    // it never writes (same discipline as applyVerdict's opts.apply guard).
    for (const v of verdicts) {
      const candidate = candidates.find((x) => x.symbol === v.symbol);
      if (!candidate || !needTime.has(v.symbol)) continue;
      if (opts.apply) {
        applyExactTimeVerdict(db, v, candidate);
      } else if (v.exact_time) {
        console.log(
          `[verify-earnings-dates] dry-run: would store exact_time ${v.exact_time} for ${v.symbol} (source: ${v.source ?? "web"})`,
        );
      }
    }

    const corrections = countCorrections();

    if (corrections > 0 && opts.apply) {
      const correctionOutcomes = outcomes.filter(
        (o) => o.action === "date-corrected" || o.action === "slot-corrected",
      );
      // Prefix each line with the symbol — the outcome's own `detail` string
      // (see applyVerdict) never carries it, and a push with no ticker in it
      // is useless.
      await sendPushover({
        title: `Earnings dates corrected (${corrections})`,
        message: correctionOutcomes.map((o) => `${o.candidate.symbol}: ${o.detail}`).join("\n"),
      });
    }

    return { outcomes, corrections };
  } catch (err) {
    console.error("[verify-earnings-dates] runEarningsDateVerification failed:", err);
    return { outcomes, corrections: countCorrections() };
  }
}

// ─── Daily gate ─────────────────────────────────────────────────────────────

function getDailyGateLastRunDay(db: Database.Database): string | null {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(DAILY_GATE_SETTINGS_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null; // settings table absent (minimal test DBs)
  }
}

function setDailyGateLastRunDay(db: Database.Database, day: string): void {
  try {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(DAILY_GATE_SETTINGS_KEY, day);
  } catch {
    // settings table absent (minimal test DBs) — best-effort, never throw
  }
}

/**
 * Once-per-ET-day gate for the daily verification pass, wired into the
 * earnings-sweep cron route (which runs every 15 min). Opens at 05:00 ET
 * (see DAILY_GATE_OPEN_HOUR_ET) so a bad vendor date/slot gets a chance to
 * be corrected before the first BMO preview email fires.
 *
 * ET hour is read from an Intl wall clock, never the local clock — the Mac
 * travels (see the ET-anchor convention in CLAUDE.md).
 *
 * Stamps the settings key BEFORE calling the runner — same stamp-before-push
 * discipline as the coverage guard (lib/calendar/coverage-guard.ts): a run
 * that throws or hangs still only gets one attempt per ET day, never a retry
 * storm from the next 15-min cron tick. Table-existence-tolerant (minimal
 * test DBs lacking a `settings` table): the gate degrades to "always eligible
 * to run" rather than throwing.
 */
export async function maybeRunDailyDateVerification(
  db: Database.Database,
  opts?: { now?: Date; runner?: typeof runEarningsDateVerification },
): Promise<{ ran: boolean }> {
  const now = opts?.now ?? new Date();

  const etHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }).format(now),
  ) % 24; // hour12:false can format midnight as "24" under some ICU builds

  if (etHour < DAILY_GATE_OPEN_HOUR_ET) return { ran: false };

  const today = todayET(now);
  if (getDailyGateLastRunDay(db) === today) return { ran: false };

  setDailyGateLastRunDay(db, today);

  const runner = opts?.runner ?? runEarningsDateVerification;
  await runner(db, { now, apply: true });

  return { ran: true };
}
