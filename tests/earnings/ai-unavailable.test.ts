/**
 * The Earnings Hub's "AI prep paused" read model and its one-line wording
 * (2026-10-27). The waiting rows decide whether there is a pause; the
 * settings marker only supplies the time. Synthetic tickers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import {
  AI_UNAVAILABLE_KEY,
  aiPrepPauseNotice,
  aiUnavailableReason,
  getAiPrepPause,
  type AiPrepPause,
} from "@/lib/earnings/ai-unavailable";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const TODAY = "2026-10-27";

function seedEvent(symbol: string, date: string, opts: { armed?: boolean; superseded?: boolean } = {}): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol, superseded)
         VALUES ('manual','earnings',?,?,?,?,?)`,
      )
      .run(date, symbol, `k-${symbol}-${date}`, symbol, opts.superseded ? 1 : 0).lastInsertRowid,
  );
  if (opts.armed !== false) armWorksheet(db, id);
  return id;
}

function seedStep(eventId: number, step: string, status: string, lastError: string | null): void {
  db.prepare(`INSERT INTO earnings_prepare_steps (event_id, step, status, last_error) VALUES (?, ?, ?, ?)`).run(
    eventId,
    step,
    status,
    lastError,
  );
}

const WAIT = aiUnavailableReason("billing");

describe("getAiPrepPause", () => {
  it("is null with no waiting rows, even when the marker is present", () => {
    const ev = seedEvent("ACME", "2026-10-28");
    seedStep(ev, "newsletter_rescan", "pending", "budget reached; resume next tick");
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      AI_UNAVAILABLE_KEY,
      JSON.stringify({ kind: "billing", since: "2026-10-27T09:12:00.000Z" }),
    );
    expect(getAiPrepPause(db, TODAY)).toBeNull();
  });

  it("counts waiting steps and prints on armed, unsuperseded, not-past events only", () => {
    const a = seedEvent("ACME", TODAY);
    const b = seedEvent("BETA", "2026-10-29");
    seedStep(a, "newsletter_rescan", "pending", WAIT);
    seedStep(a, "newsletter_synthesis", "pending", WAIT);
    seedStep(b, "newsletter_rescan", "pending", WAIT);
    seedStep(b, "newsletter_synthesis", "failed", "deep read returned no readable sheet");
    seedStep(seedEvent("PAST", "2026-10-26"), "newsletter_rescan", "pending", WAIT);
    seedStep(seedEvent("UNARM", "2026-10-28", { armed: false }), "newsletter_rescan", "pending", WAIT);
    seedStep(seedEvent("SUPER", "2026-10-28", { superseded: true }), "newsletter_rescan", "pending", WAIT);
    // A failed row whose text happens to carry the prefix is not waiting.
    seedStep(seedEvent("DONE", "2026-10-28"), "newsletter_rescan", "failed", WAIT);

    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      AI_UNAVAILABLE_KEY,
      JSON.stringify({ kind: "billing", since: "2026-10-27T09:12:00.000Z" }),
    );
    expect(getAiPrepPause(db, TODAY)).toEqual({
      kind: "billing",
      since: "2026-10-27T09:12:00.000Z",
      waitingSteps: 3,
      waitingPrints: 2,
    });
  });

  it("without a marker the kind comes from the waiting row and the time is omitted", () => {
    seedStep(seedEvent("ACME", "2026-10-28"), "newsletter_rescan", "pending", aiUnavailableReason("rate_limit"));
    expect(getAiPrepPause(db, TODAY)).toEqual({ kind: "rate_limit", since: null, waitingSteps: 1, waitingPrints: 1 });
  });
});

describe("aiPrepPauseNotice", () => {
  const pause = (over: Partial<AiPrepPause> = {}): AiPrepPause => ({
    kind: "billing",
    since: "2026-10-27T09:12:00.000Z", // 5:12 am Eastern (EDT)
    waitingSteps: 12,
    waitingPrints: 6,
    ...over,
  });

  it("states the Eastern time, the reason and the counts", () => {
    expect(aiPrepPauseNotice(pause(), TODAY)).toBe(
      "AI prep paused since 5:12 am ET — Anthropic credit balance is empty. " +
        "12 prep steps for 6 armed prints are waiting and will run on their own once it's fixed.",
    );
  });

  it("adds the date when the outage began on another Eastern day", () => {
    // 01:30 UTC on the 27th is still the 26th in New York.
    expect(aiPrepPauseNotice(pause({ since: "2026-10-27T01:30:00.000Z" }), TODAY)).toMatch(
      /^AI prep paused since 2026-10-26 9:30 pm ET — /,
    );
  });

  it("omits the time when no marker is recorded, and uses the singular for one step", () => {
    expect(aiPrepPauseNotice(pause({ since: null, waitingSteps: 1, waitingPrints: 1 }), TODAY)).toBe(
      "AI prep paused — Anthropic credit balance is empty. " +
        "1 prep step for 1 armed print is waiting and will run on its own once it's fixed.",
    );
  });

  it("says the service will recover for a passing failure, and needs fixing otherwise", () => {
    expect(aiPrepPauseNotice(pause({ kind: "rate_limit" }), TODAY)).toMatch(/once the AI service recovers\.$/);
    expect(aiPrepPauseNotice(pause({ kind: "outage" }), TODAY)).toMatch(/once the AI service recovers\.$/);
    expect(aiPrepPauseNotice(pause({ kind: "network" }), TODAY)).toMatch(/once the AI service recovers\.$/);
    expect(aiPrepPauseNotice(pause({ kind: "auth" }), TODAY)).toMatch(/once it's fixed\.$/);
  });

  it("maps every account-level kind to plain words", () => {
    const words = (kind: AiPrepPause["kind"]) =>
      aiPrepPauseNotice(pause({ kind, since: null }), TODAY).split(" — ")[1].split(". ")[0];
    expect(words("billing")).toBe("Anthropic credit balance is empty");
    expect(words("auth")).toBe("the Anthropic API key was rejected");
    expect(words("rate_limit")).toBe("Anthropic is rate-limiting requests");
    expect(words("outage")).toBe("Anthropic's service is unavailable");
    expect(words("network")).toBe("no connection to the AI service");
    expect(words("config")).toBe("the AI key is not configured");
  });
});
