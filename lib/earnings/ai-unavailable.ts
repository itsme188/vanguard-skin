/**
 * The earnings prepare pipeline's view of an AI ACCOUNT outage (2026-10-27).
 *
 * Incident: the Anthropic account ran out of credit and every armed print's
 * AI prepare steps burned their retry caps on the billing error (48 article
 * scans spent for good). Owner ruling: an account-level AI failure never
 * consumes an attempt; the work waits as `pending` and reruns on its own
 * once the account answers again. An article-level or unknown failure counts
 * exactly as before.
 *
 * Who is at fault is decided by the research feed's classifier
 * (`classifyEnrichmentError`, lib/gmail/enrichment-failure.ts), never a
 * second one. This module holds:
 *   - the pending reason the waiting steps store, whose fixed prefix is how
 *     the Earnings Hub counts them;
 *   - the `settings` marker that remembers when the outage was first seen;
 *   - the hub's read model and its one-line wording (pure, no db singleton).
 */
import type Database from "better-sqlite3";
import { classifyEnrichmentError, type EnrichmentFailureKind } from "@/lib/gmail/enrichment-failure";
import { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "@/lib/ai/classify-anthropic-error";

export type AccountFailureKind = Extract<
  EnrichmentFailureKind,
  "billing" | "auth" | "rate_limit" | "outage" | "network" | "config"
>;

const ACCOUNT_FAILURE_KINDS: ReadonlySet<string> = new Set<AccountFailureKind>([
  "billing",
  "auth",
  "rate_limit",
  "outage",
  "network",
  "config",
]);

function isAccountFailureKind(v: unknown): v is AccountFailureKind {
  return typeof v === "string" && ACCOUNT_FAILURE_KINDS.has(v);
}

/** The fixed start of every waiting step's `last_error`; the hub counts rows by it. */
export const AI_UNAVAILABLE_REASON_PREFIX = "AI unavailable (";

export function aiUnavailableReason(kind: AccountFailureKind): string {
  return `${AI_UNAVAILABLE_REASON_PREFIX}${kind}): waiting; no attempt counted`;
}

/**
 * The account-level kind of a caught error, or null when the fault is the
 * article's (or unknown). An error that wraps the provider's error on `cause`
 * (extractBogeysFromArticleForEvent) is read through it first.
 *
 * Two error families reach here: the AI SDK's (generateObjectForFeature and
 * friends, read by classifyEnrichmentError) and the raw `@anthropic-ai/sdk`
 * client's `APIError` (the earnings-date check, 2026-10-28, read by
 * rawSdkAccountFailure). Each reader returns null for the other's errors.
 */
export function accountFailureOf(err: unknown): AccountFailureKind | null {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  if (cause !== undefined) {
    const fromCause = classifyOne(cause);
    if (fromCause) return fromCause;
  }
  return classifyOne(err);
}

function classifyOne(err: unknown): AccountFailureKind | null {
  const c = classifyEnrichmentError(err);
  if (c.scope === "account" && isAccountFailureKind(c.kind)) return c.kind;
  return rawSdkAccountFailure(err);
}

/**
 * A raw `@anthropic-ai/sdk` error. The kind comes from the shared raw-SDK
 * classifier (lib/ai/classify-anthropic-error.ts), which knows the credit
 * message; the two shapes it leaves as "unknown" are read here: no connection
 * (`APIConnectionError`, which also covers a timeout) and a 408 or 5xx.
 */
function rawSdkAccountFailure(err: unknown): AccountFailureKind | null {
  if (err instanceof APIConnectionError) return "network";
  if (!(err instanceof APIError)) return null;
  switch (classifyAnthropicError(err)?.kind) {
    case "billing":
      return "billing";
    case "auth":
      return "auth";
    case "rate_limit":
      return "rate_limit";
    case "overloaded":
      return "outage";
  }
  const status = err.status ?? 0;
  return status === 408 || status >= 500 ? "outage" : null;
}

// ── The outage marker ────────────────────────────────────────────────

export const AI_UNAVAILABLE_KEY = "earnings_ai_unavailable";

export interface AiUnavailableMarker {
  kind: AccountFailureKind;
  /** First time the outage was seen, ISO UTC. */
  since: string;
}

/** Read-only. An absent or unreadable row is "no outage recorded". */
export function getAiUnavailableMarker(db: Database.Database): AiUnavailableMarker | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(AI_UNAVAILABLE_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown> | null;
    if (!parsed || !isAccountFailureKind(parsed.kind) || typeof parsed.since !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.since))) return null;
    return { kind: parsed.kind, since: parsed.since };
  } catch {
    return null;
  }
}

/** Records an account failure. Keeps the FIRST `since`; updates the kind when it changed. */
export function recordAiUnavailable(db: Database.Database, kind: AccountFailureKind, now: Date = new Date()): void {
  const existing = getAiUnavailableMarker(db);
  if (existing && existing.kind === kind) return;
  const marker: AiUnavailableMarker = { kind, since: existing?.since ?? now.toISOString() };
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(AI_UNAVAILABLE_KEY, JSON.stringify(marker));
}

/** The account answered: the outage is over. */
export function clearAiUnavailable(db: Database.Database): void {
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(AI_UNAVAILABLE_KEY);
}

// ── The Earnings Hub read model ──────────────────────────────────────

export interface AiPrepPause {
  kind: AccountFailureKind;
  /** ISO UTC, or null when the marker is missing (the rows are still the truth). */
  since: string | null;
  waitingSteps: number;
  waitingPrints: number;
}

/**
 * Null, or the prepare steps waiting on the AI account: pending rows whose
 * reason carries the account-failure prefix, on armed, unsuperseded events
 * dated today (Eastern) or later. The rows decide whether there is a pause;
 * the marker only supplies the time.
 */
export function getAiPrepPause(db: Database.Database, today: string): AiPrepPause | null {
  const prefix = AI_UNAVAILABLE_REASON_PREFIX;
  const rows = db
    .prepare(
      `SELECT p.event_id, p.last_error
         FROM earnings_prepare_steps p JOIN calendar_events ce ON ce.id = p.event_id
        WHERE p.status = 'pending' AND substr(p.last_error, 1, ?) = ?
          AND ce.event_date >= ? AND COALESCE(ce.superseded, 0) = 0
          AND EXISTS (SELECT 1 FROM earnings_worksheet_flags f WHERE f.event_id = ce.id)
        ORDER BY datetime(p.updated_at) DESC`,
    )
    .all(prefix.length, prefix, today) as { event_id: number; last_error: string }[];
  if (rows.length === 0) return null;
  const marker = getAiUnavailableMarker(db);
  // Without a marker, the newest waiting row names the kind.
  const fromRow = rows[0].last_error.slice(prefix.length).split(")")[0];
  const kind = marker?.kind ?? (isAccountFailureKind(fromRow) ? fromRow : null);
  if (!kind) return null;
  return {
    kind,
    since: marker?.since ?? null,
    waitingSteps: rows.length,
    waitingPrints: new Set(rows.map((r) => r.event_id)).size,
  };
}

const KIND_WORDS: Record<AccountFailureKind, string> = {
  billing: "Anthropic credit balance is empty",
  auth: "the Anthropic API key was rejected",
  rate_limit: "Anthropic is rate-limiting requests",
  outage: "Anthropic's service is unavailable",
  network: "no connection to the AI service",
  config: "the AI key is not configured",
};

function sinceText(since: string | null, today: string): string {
  if (!since) return "";
  const at = new Date(since);
  if (Number.isNaN(at.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(at)
    .replace(/\s?([AP])M$/i, (_m, ap: string) => ` ${ap.toLowerCase()}m`);
  return ` since ${day === today ? "" : `${day} `}${time} ET`;
}

const TRANSIENT_KINDS: ReadonlySet<AccountFailureKind> = new Set<AccountFailureKind>(["rate_limit", "outage", "network"]);

/** The hub's one-line notice. `today` is the Eastern day (todayET()). */
export function aiPrepPauseNotice(pause: AiPrepPause, today: string): string {
  const steps = pause.waitingSteps === 1 ? "1 prep step" : `${pause.waitingSteps} prep steps`;
  const prints = pause.waitingPrints === 1 ? "1 armed print" : `${pause.waitingPrints} armed prints`;
  const verb = pause.waitingSteps === 1 ? "is waiting and will run on its own" : "are waiting and will run on their own";
  // Billing, a rejected key and a missing key need the owner; the rest pass by themselves.
  const until = TRANSIENT_KINDS.has(pause.kind) ? "once the AI service recovers" : "once it's fixed";
  return (
    `AI prep paused${sinceText(pause.since, today)} — ${KIND_WORDS[pause.kind]}. ` +
    `${steps} for ${prints} ${verb} ${until}.`
  );
}
