/**
 * An account-level AI failure never spends a retry in the earnings prepare
 * pipeline (incident 2026-10-27: the Anthropic account ran out of credit and
 * every armed print's newsletter scans burned their caps on the billing
 * error). The work waits as `pending` and reruns once the account answers.
 * An article-level or unknown failure counts exactly as before.
 *
 * The provider errors are built by the real AI SDK against a stubbed network
 * (tests/helpers/ai-sdk-real-errors.ts), never hand-made. Synthetic tickers
 * and figures only.
 */
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const generateTextMock = vi.fn();
vi.mock("@/lib/ai/generate", () => ({
  generateTextForFeature: (...a: unknown[]) => generateTextMock(...a),
  AIRefusalError: class AIRefusalError extends Error {},
}));
vi.mock("@/lib/ai/models", () => ({
  resolveFeatureModel: vi.fn(() => ({ provider: "anthropic", modelId: "claude-test-model" })),
}));

import { ANTHROPIC_FAILURES, errorFromRealSdk } from "../helpers/ai-sdk-real-errors";
import { classifyEnrichmentError } from "@/lib/gmail/enrichment-failure";
import { extractBogeysFromArticleForEvent, type ArticleInput } from "@/lib/earnings/extract-newsletter-bogeys";
import { makeNewsletterRescanStep } from "@/lib/earnings/prepare-steps/newsletter-rescan";
import { makeNewsletterSynthesisStep } from "@/lib/earnings/prepare-steps/newsletter-synthesis";
import {
  registerPrepareStep,
  __resetPrepareStepsForTests,
  enqueuePrepareSteps,
  runPrepareSteps,
} from "@/lib/earnings/prepare-armed-event";
import { AI_UNAVAILABLE_KEY, aiUnavailableReason, getAiUnavailableMarker } from "@/lib/earnings/ai-unavailable";
import { armWorksheet } from "@/lib/mutations/earnings-worksheet-flags";
import type { FetchNewsletterImagesFn, NewsletterImageFetchResult } from "@/lib/earnings/newsletter-images";
import { normalizeNewsletterHtml, sanitizeNewsletterHtml } from "@/lib/gmail/sanitize";
import { PNG_BYTES, SUBSTACK_IMAGE_ONLY_TEXT, substackImageOnlyEmail } from "../helpers/substack-email-fixture";

let billing400: unknown;
let billing402: unknown;
let badRequest400: unknown;
beforeAll(async () => {
  billing400 = (await errorFromRealSdk(ANTHROPIC_FAILURES.billing400)).error;
  billing402 = (await errorFromRealSdk(ANTHROPIC_FAILURES.billing402)).error;
  badRequest400 = (await errorFromRealSdk(ANTHROPIC_FAILURES.promptTooLong400)).error;
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO research_sources (id, name) VALUES (9001, 'Desk Notes')`).run();
  __resetPrepareStepsForTests();
});
afterEach(() => {
  generateTextMock.mockReset();
  __resetPrepareStepsForTests();
});

const ctx = { now: () => Date.now(), signal: new AbortController().signal };

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}
function daysAhead(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const FILLER =
  " Desk prose that exists only to clear the two-hundred-character floor the scan query enforces on a newsletter body.".repeat(
    3,
  );

function seedEvent(): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('manual','earnings',?,'ACME','k-acme','ACME')`,
      )
      .run(daysAhead(2)).lastInsertRowid,
  );
  armWorksheet(db, id);
  return id;
}

function seedArticle(text: string, ago: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, bogeys_scanned_at)
         VALUES (9001, 'Buyside Bogeys', 'desk@example.test', ?, ?, ?)`,
      )
      .run(daysAgo(ago), text + FILLER, daysAgo(ago)).lastInsertRowid,
  );
}

const ledger = (ev: number) =>
  db
    .prepare(`SELECT article_id, status, attempts FROM earnings_bogey_scans WHERE event_id = ? ORDER BY article_id`)
    .all(ev) as { article_id: number; status: string; attempts: number }[];

const RESPONSE = JSON.stringify([{ symbol: "ACME", eps_consensus: 0.6, revenue_consensus: 1.51e9 }]);

describe("newsletter_rescan: an account-level failure costs no attempt and stops the pass", () => {
  for (const [label, err] of [
    ["HTTP 400 with the credit message", () => billing400],
    ["HTTP 402 billing_error", () => billing402],
  ] as const) {
    it(`${label}: one model call, the scan row's attempts unchanged, the step pending`, async () => {
      const ev = seedEvent();
      seedArticle("ACME EPS 0.60", 1);
      seedArticle("ACME rev 1.51B", 2);
      seedArticle("ACME guide light", 3);
      generateTextMock.mockRejectedValue(err());

      const step = makeNewsletterRescanStep();
      expect(await step.run(db, ev, ctx)).toEqual({
        status: "pending",
        reason: aiUnavailableReason("billing"),
        accountFailure: "billing",
      });
      expect(generateTextMock).toHaveBeenCalledTimes(1);
      // The one tried pair is released as a retryable error at attempts 0; the
      // others were never claimed.
      expect(ledger(ev).map((r) => [r.status, r.attempts])).toEqual([["error", 0]]);

      // A second outage pass still spends nothing.
      expect((await step.run(db, ev, ctx)).status).toBe("pending");
      expect(ledger(ev).map((r) => r.attempts)).toEqual([0]);

      // The account is back: every article is scanned normally.
      generateTextMock.mockReset();
      generateTextMock.mockResolvedValue({ text: RESPONSE });
      expect(await step.run(db, ev, ctx)).toEqual({ status: "done", note: "3 scanned, 3 hit" });
      expect(ledger(ev).map((r) => [r.status, r.attempts])).toEqual([
        ["hit", 1],
        ["hit", 1],
        ["hit", 1],
      ]);
    });
  }

  it("an article-level failure (a 400 that is not billing) still counts one attempt and the pass goes on", async () => {
    const ev = seedEvent();
    seedArticle("ACME EPS 0.60", 1);
    seedArticle("ACME rev 1.51B", 2);
    generateTextMock.mockRejectedValue(badRequest400);
    expect(classifyEnrichmentError(badRequest400).scope).toBe("article");

    expect(await makeNewsletterRescanStep().run(db, ev, ctx)).toEqual({
      status: "failed",
      error: "2 article scan(s) failed",
    });
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(ledger(ev).map((r) => [r.status, r.attempts])).toEqual([
      ["error", 1],
      ["error", 1],
    ]);
  });
});

describe("extractBogeysFromArticleForEvent keeps the provider's error", () => {
  const fetchAll: FetchNewsletterImagesFn = vi.fn(async (urls: string[]): Promise<NewsletterImageFetchResult> => ({
    images: urls.map((url) => ({ url, mediaType: "image/png" as const, data: new Uint8Array(PNG_BYTES) })),
    expected: urls.length,
    failures: [],
  }));

  it("a billing 400 with images attached is not re-sent as text only, and rides on .cause", async () => {
    const ev = seedEvent();
    const html = normalizeNewsletterHtml(sanitizeNewsletterHtml(substackImageOnlyEmail()));
    const art = Number(
      db
        .prepare(
          `INSERT INTO research_articles (source_id, subject, sender, received_at, raw_text, raw_html)
           VALUES (9001, 'Desk Bogeys: ACME, ZETA', 'desk@example.test', ?, ?, ?)`,
        )
        .run(daysAgo(1), SUBSTACK_IMAGE_ONLY_TEXT, html).lastInsertRowid,
    );
    const article = db
      .prepare(
        `SELECT a.id, rs.name AS source_name, a.subject, a.received_at, a.raw_text, a.raw_html
           FROM research_articles a JOIN research_sources rs ON rs.id = a.source_id WHERE a.id = ?`,
      )
      .get(art) as ArticleInput;
    generateTextMock.mockRejectedValue(billing400);

    let thrown: unknown;
    try {
      await extractBogeysFromArticleForEvent(
        db,
        article,
        { event_id: ev, symbol: "ACME", event_date: daysAhead(2) },
        { fetchImages: fetchAll },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][1].messages[0].content.some((c: { type: string }) => c.type === "image")).toBe(
      true,
    );
    expect(classifyEnrichmentError((thrown as Error).cause).kind).toBe("billing");
  });
});

describe("newsletter_synthesis", () => {
  it("an account-level failure waits as pending; a parse failure is still failed", async () => {
    const ev = seedEvent();
    const billing = makeNewsletterSynthesisStep({
      run: async () => {
        throw billing400;
      },
    });
    expect(await billing.run(db, ev, ctx)).toEqual({
      status: "pending",
      reason: aiUnavailableReason("billing"),
      accountFailure: "billing",
    });

    const parse = makeNewsletterSynthesisStep({
      run: async () => {
        throw new Error("deep read returned no readable sheet");
      },
    });
    expect(await parse.run(db, ev, ctx)).toEqual({
      status: "failed",
      error: "deep read returned no readable sheet",
    });
  });
});

describe("runPrepareSteps safety net + outage marker", () => {
  const row = (ev: number, step: string) =>
    db
      .prepare(`SELECT status, attempts, last_error FROM earnings_prepare_steps WHERE event_id = ? AND step = ?`)
      .get(ev, step) as { status: string; attempts: number; last_error: string | null };

  it("a step that THROWS an account-level failure is booked pending with no attempt", async () => {
    registerPrepareStep("ai_thrower", {
      usesAi: true,
      fingerprint: () => "f",
      run: async () => {
        throw billing402;
      },
    });
    const ev = seedEvent();
    enqueuePrepareSteps(db, ev);
    expect(await runPrepareSteps(db, { eventId: ev })).toMatchObject({ ran: 1, pending: 1, failed: 0 });
    expect(row(ev, "ai_thrower")).toEqual({
      status: "pending",
      attempts: 0,
      last_error: aiUnavailableReason("billing"),
    });
  });

  it("a step cut off by the runner's deadline still counts, even when it rejects with an abort", async () => {
    registerPrepareStep("hangs", {
      fingerprint: () => "f",
      run: (_db, _id, c) =>
        new Promise((_resolve, reject) => {
          c.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const ev = seedEvent();
    enqueuePrepareSteps(db, ev);
    expect(await runPrepareSteps(db, { eventId: ev, stepTimeoutMs: 20 })).toMatchObject({ failed: 1, pending: 0 });
    expect(row(ev, "hangs")).toMatchObject({ status: "failed", attempts: 1 });
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(AI_UNAVAILABLE_KEY)).toBeUndefined();
  });

  it("the marker is set on the first account failure, keeps its first time, and clears when an AI step answers", async () => {
    let mode: "billing" | "auth" | "done" = "billing";
    registerPrepareStep("ai_step", {
      usesAi: true,
      fingerprint: () => "f",
      run: async () =>
        mode === "done"
          ? { status: "done" }
          : { status: "pending", reason: aiUnavailableReason(mode), accountFailure: mode },
    });
    const ev = seedEvent();
    enqueuePrepareSteps(db, ev);
    const t0 = Date.parse("2026-10-27T09:12:00Z");

    await runPrepareSteps(db, { eventId: ev, now: () => t0 });
    expect(getAiUnavailableMarker(db)).toEqual({ kind: "billing", since: "2026-10-27T09:12:00.000Z" });

    await runPrepareSteps(db, { eventId: ev, now: () => t0 + 15 * 60_000 });
    expect(getAiUnavailableMarker(db)).toEqual({ kind: "billing", since: "2026-10-27T09:12:00.000Z" });

    mode = "auth";
    await runPrepareSteps(db, { eventId: ev, now: () => t0 + 30 * 60_000 });
    expect(getAiUnavailableMarker(db)).toEqual({ kind: "auth", since: "2026-10-27T09:12:00.000Z" });
    expect(row(ev, "ai_step")).toMatchObject({ status: "pending", attempts: 0 });

    mode = "done";
    await runPrepareSteps(db, { eventId: ev, now: () => t0 + 45 * 60_000 });
    expect(getAiUnavailableMarker(db)).toBeNull();
    expect(row(ev, "ai_step")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("an AI step that waits for another reason (no model call proven) leaves the marker", async () => {
    registerPrepareStep("ai_budget", {
      usesAi: true,
      fingerprint: () => "f",
      run: async () => ({ status: "pending", reason: "budget reached; resume next tick" }),
    });
    const ev = seedEvent();
    enqueuePrepareSteps(db, ev);
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      AI_UNAVAILABLE_KEY,
      JSON.stringify({ kind: "billing", since: "2026-10-27T09:12:00.000Z" }),
    );
    await runPrepareSteps(db, { eventId: ev });
    expect(getAiUnavailableMarker(db)).toEqual({ kind: "billing", since: "2026-10-27T09:12:00.000Z" });
  });

  it("a step that does not use AI never clears the marker", async () => {
    registerPrepareStep("con_id_like", { fingerprint: () => "f", run: async () => ({ status: "done" }) });
    const ev = seedEvent();
    enqueuePrepareSteps(db, ev);
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(
      AI_UNAVAILABLE_KEY,
      JSON.stringify({ kind: "billing", since: "2026-10-27T09:12:00.000Z" }),
    );
    await runPrepareSteps(db, { eventId: ev });
    expect(getAiUnavailableMarker(db)).toEqual({ kind: "billing", since: "2026-10-27T09:12:00.000Z" });
  });
});
