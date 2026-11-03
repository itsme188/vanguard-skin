/**
 * Durable note of provider-failover switches (provider-failover design slice 2).
 *
 * Storage: `settings` key `ai_failover_log`, a JSON array of the newest
 * switches (capped), so an operator can see which provider served a run and
 * the Earnings Hub can say "running on OpenAI". Written through the recorder
 * lib/db.ts registers with lib/ai/failover.ts; takes `db` like every
 * mutation. Never throws into the AI call (the recorder wrapper catches).
 */
import type Database from "better-sqlite3";
import type { FailoverEvent } from "@/lib/ai/failover";

export const AI_FAILOVER_LOG_KEY = "ai_failover_log";
export const AI_FAILOVER_LOG_CAP = 20;

export interface FailoverLogEntry {
  feature: string;
  from: string;
  to: string;
  toModel: string;
  kind: string;
  /** ISO UTC. */
  at: string;
}

export function readFailoverLog(db: Database.Database): FailoverLogEntry[] {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(AI_FAILOVER_LOG_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is FailoverLogEntry =>
        !!e && typeof e === "object" &&
        typeof (e as FailoverLogEntry).feature === "string" &&
        typeof (e as FailoverLogEntry).to === "string" &&
        typeof (e as FailoverLogEntry).at === "string",
    );
  } catch {
    return [];
  }
}

export function recordFailoverEvent(db: Database.Database, event: FailoverEvent): void {
  const entry: FailoverLogEntry = {
    feature: event.feature,
    from: event.from.provider,
    to: event.to.provider,
    toModel: event.to.modelId,
    kind: event.kind,
    at: event.at,
  };
  const next = [...readFailoverLog(db), entry].slice(-AI_FAILOVER_LOG_CAP);
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
  ).run(AI_FAILOVER_LOG_KEY, JSON.stringify(next));
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  "workers-ai": "Cloudflare Workers AI",
};

/**
 * The provider currently carrying work: the one that served the newest switch
 * within `windowMs` of `now` (default 60 minutes), as a display name; else null.
 */
export function activeFailoverProviderName(
  db: Database.Database,
  now: Date = new Date(),
  windowMs = 60 * 60 * 1000,
): string | null {
  const log = readFailoverLog(db);
  const last = log[log.length - 1];
  if (!last) return null;
  const at = Date.parse(last.at);
  if (Number.isNaN(at) || now.getTime() - at > windowMs) return null;
  return PROVIDER_NAMES[last.to] ?? last.to;
}
