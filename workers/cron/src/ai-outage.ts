/**
 * The Worker's posture during an AI ACCOUNT outage (provider-failover design
 * slice 5, 2026-11-02: docs/superpowers/specs/2026-11-02-provider-failover-design.md §9).
 *
 * The Mac side parks work when the Anthropic account fails (out of credit,
 * key rejected, service down): no attempt is spent, the step waits as
 * `pending` (lib/earnings/ai-unavailable.ts). The Worker has no per-row
 * attempt counters, but it had the same two failure modes:
 *   - it KEPT CALLING a dead account: every article in a run, and every
 *     15-minute catch-up tick, each ending in a doomed request;
 *   - it REPORTED the outage as something else ("no_articles" for the hourly
 *     newsletter fetch, a generic "error" for the briefing).
 *
 * This module is the Worker's version of "park": the SAME classifier
 * vocabulary (`classifyEnrichmentError`, a byte-identical copy of
 * lib/gmail/enrichment-failure.ts, parity-pinned), a short-lived KV marker,
 * and one distinct result kind, `ai_unavailable`. Nothing here chooses a
 * provider: Worker provider routing (a fallback model) is separate work.
 *
 * The marker is a note for the next tick, never a lock on the happy path: it
 * only exists after a real account-level failure, it expires by itself
 * (persistent kinds 30 min, transient kinds 5 min), and only work with NO
 * degraded alternative (the briefing, the hourly newsletter fetch) consults
 * it before calling. The digest and evening emails still send their
 * snapshot-based layouts, as before.
 */
import { classifyEnrichmentError, type EnrichmentFailureKind } from "./enrichment-failure";

/** The six account-level kinds (same set as the Mac's AccountFailureKind). */
export type AccountFailureKind = Extract<
  EnrichmentFailureKind,
  "billing" | "auth" | "rate_limit" | "outage" | "network" | "config"
>;

const ACCOUNT_KINDS: ReadonlySet<string> = new Set<AccountFailureKind>([
  "billing",
  "auth",
  "rate_limit",
  "outage",
  "network",
  "config",
]);

/** The account-level kind of a caught AI error, or null (article-level / unknown). */
export function accountFailureOf(err: unknown): AccountFailureKind | null {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  for (const candidate of cause !== undefined ? [cause, err] : [err]) {
    const c = classifyEnrichmentError(candidate);
    if (c.scope === "account" && ACCOUNT_KINDS.has(c.kind)) return c.kind as AccountFailureKind;
  }
  return null;
}

export const AI_OUTAGE_KEY = "ai-unavailable";
const PERSISTENT_TTL_SECONDS = 30 * 60;
const TRANSIENT_TTL_SECONDS = 5 * 60; // KV's minimum expirationTtl is 60

const TRANSIENT: ReadonlySet<AccountFailureKind> = new Set<AccountFailureKind>(["rate_limit", "outage", "network"]);

export interface AiOutageMarker {
  kind: AccountFailureKind;
  /** First time this outage was seen, ISO UTC. Kept across re-records. */
  since: string;
}

export async function getAiOutage(kv: KVNamespace): Promise<AiOutageMarker | null> {
  const raw = await kv.get(AI_OUTAGE_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<AiOutageMarker> | null;
    if (!p || typeof p.kind !== "string" || !ACCOUNT_KINDS.has(p.kind) || typeof p.since !== "string") return null;
    return { kind: p.kind as AccountFailureKind, since: p.since };
  } catch {
    return null;
  }
}

/** Note an account failure. Never throws: a KV hiccup must not turn a parked run into a crash. */
export async function recordAiOutage(kv: KVNamespace, kind: AccountFailureKind): Promise<void> {
  try {
    const existing = await getAiOutage(kv);
    const marker: AiOutageMarker = { kind, since: existing?.since ?? new Date().toISOString() };
    await kv.put(AI_OUTAGE_KEY, JSON.stringify(marker), {
      expirationTtl: TRANSIENT.has(kind) ? TRANSIENT_TTL_SECONDS : PERSISTENT_TTL_SECONDS,
    });
  } catch (err) {
    console.warn("[ai-outage] could not record the marker:", err instanceof Error ? err.message : String(err));
  }
}

/** Plain-English reason stored in results/logs. Fixed prefix, like the Mac's. */
export function aiUnavailableReason(kind: AccountFailureKind): string {
  return `AI unavailable (${kind}): parked; no retry burned`;
}
