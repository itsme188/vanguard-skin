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
      `SELECT id, symbol, event_date, event_time, release_time, source
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND COALESCE(superseded, 0) = 0
          AND symbol IS NOT NULL
          AND actual_value IS NULL
          AND date_verified_at IS NULL
          AND event_date BETWEEN ? AND ?
        ORDER BY event_date ASC, id ASC`,
    )
    .all(today, horizon) as DateVerificationCandidate[];

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
): string {
  const lines = candidates.map((c) => {
    const slot = effectiveSlot(c) ?? "unknown slot";
    return `- ${c.symbol} — vendor says ${c.event_date}, ${slot}`;
  });
  return `You are verifying upcoming earnings report dates. Today is ${todayStr}.

For EACH company below, find the CONFIRMED date and timing of its next quarterly earnings report. Prefer the company's own investor-relations announcement or press release ("X to report results on ..."). A wire story or two agreeing independent calendars also count as confirmation. bmo = before the market opens, amc = after the market closes.

The vendor date/slot shown may be WRONG — that is why you are verifying. Do not assume it is right.

Candidates:
${lines.join("\n")}

Respond ONLY with a JSON array, one object per candidate symbol, no prose:
[{"symbol":"XYZ","confirmed_date":"YYYY-MM-DD","slot":"bmo","confidence":"confirmed","source":"<url or short citation>"}]

Rules: "confidence":"confirmed" ONLY with an explicit company announcement or two agreeing independent sources. If you cannot confirm, use "confidence":"unconfirmed" and set "confirmed_date" to your best finding or null. NEVER invent a date.`;
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

  return { symbol: r.symbol.trim(), confirmed_date, slot, confidence, source };
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
  opts: { apply: boolean },
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
      if (!result.ok) {
        return { candidate, action: "refused", detail: result.refusedReason ?? "correction refused" };
      }
      stamp(note, result.newEventId!);
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
  if (!result.ok) {
    return { candidate, action: "refused", detail: result.refusedReason ?? "correction refused" };
  }
  stamp(note, result.newEventId!);
  return { candidate, action: "date-corrected", detail: note };
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
 */
export async function runEarningsDateVerification(
  db: Database.Database,
  opts?: {
    now?: Date;
    apply?: boolean;
    limit?: number;
    fetchVerdicts?: (prompt: string) => Promise<string>;
  },
): Promise<{ outcomes: VerificationOutcome[]; corrections: number }> {
  const outcomes: VerificationOutcome[] = [];
  const countCorrections = () =>
    outcomes.filter((o) => o.action === "date-corrected" || o.action === "slot-corrected").length;

  try {
    const limit = opts?.limit ?? DEFAULT_VERIFICATION_LIMIT;
    const candidates = findDateVerificationCandidates(db, { now: opts?.now, limit });
    if (candidates.length === 0) return { outcomes, corrections: 0 };

    const today = todayET(opts?.now);
    const prompt = buildDateVerificationPrompt(candidates, today);
    const fetcher = opts?.fetchVerdicts ?? defaultFetchDateVerdicts;

    const text = await fetcher(prompt);
    const verdicts = parseDateVerdicts(text);

    const verdictBySymbol = new Map<string, DateVerdict>();
    for (const v of verdicts) verdictBySymbol.set(v.symbol.toUpperCase(), v);

    const applyFlag = opts?.apply !== false;
    for (const candidate of candidates) {
      const family = issuerSiblings(candidate.symbol.toUpperCase()).map((s) => s.toUpperCase());
      const verdict = family.map((sym) => verdictBySymbol.get(sym)).find((v) => v !== undefined);
      outcomes.push(applyVerdict(db, candidate, verdict, { apply: applyFlag }));
    }

    const corrections = countCorrections();

    if (corrections > 0 && opts?.apply !== false) {
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
  await runner(db, { now });

  return { ran: true };
}
