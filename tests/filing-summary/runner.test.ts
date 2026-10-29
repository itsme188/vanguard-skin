/**
 * Filing summary runner (Task 10): runs, sections, bounded attempts and
 * companion ordering, against the migrated in-memory schema with a fake
 * model call. Synthetic data only; model ids come from a catalog fixture.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setModelCatalogSource } from "@/lib/ai/catalog-source";
import { AIRefusalError, AITruncatedError, AIModelUnavailableError } from "@/lib/ai/generate";
import {
  appendCompanion,
  autoRunKey,
  ensureAutoRun,
  INPUT_CAP_CHARS,
  onEarningsAccepted,
  retryRun,
  retryRunWithReason,
  ROUTINE_SKIP_REASON,
  runNextSection,
  SECTION_CALL_TIMEOUT_MS,
  SECTION_MAX_OUTPUT_TOKENS,
  startRun,
  type RunnerSeams,
} from "@/lib/filing-summary/runner";
import {
  claimNextSection,
  insertFiling,
  listRuns,
  listSections,
  upsertDocument,
  upsertEventState,
  type NewFiling,
} from "@/lib/filing-summary/store";
import type { CheckedSection, CoverageEntry } from "@/lib/filing-summary/types";
import { AI_UNAVAILABLE_REASON_PREFIX } from "@/lib/earnings/ai-unavailable";
import {
  ANTHROPIC_FAILURES,
  errorFromRealSdk,
  fetchFailed,
  type AnthropicFailureName,
} from "../helpers/ai-sdk-real-errors";
import { SCHEMA_VERSION } from "@/lib/filing-summary/schema";
import { PROMPT_VERSION } from "@/lib/filing-summary/prompt";
import { EXTRACTOR_VERSION } from "@/lib/filing-summary/doc-text";
import { CHECKER_VERSION } from "@/lib/filing-summary/evaluate";

const CATALOG = ["claude-opus-5-5", "claude-sonnet-5-5"];
const T0 = Date.parse("2026-10-22T20:30:00.000Z");
const MIN = 60_000;

const EX991_HTML =
  "<html><body><p>Synthetic Widgets Inc. reported third quarter results today.</p>" +
  "<p>Revenue rose sharply in the quarter.</p></body></html>";
const PRE14C_HTML = "<html><body><p>The board approved a share class conversion.</p></body></html>";

let db: Database.Database;
let eventId: number;
let files: Map<string, string>;
let tokenN: number;

function seedEvent(symbol: string, key: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, source_key, symbol)
         VALUES ('finnhub','earnings','2026-10-22',?,?,?)`,
      )
      .run(`${symbol} earnings`, key, symbol).lastInsertRowid,
  );
}

function filing(accession: string, over: Partial<NewFiling> = {}): NewFiling {
  return {
    eventId,
    accession,
    cik: "0000000001",
    form: "8-K",
    role: "earnings",
    items: "2.02,9.01",
    acceptedAt: "2026-10-22T20:05:00.000Z",
    discoveredAt: "2026-10-22T20:06:00.000Z",
    identityVerdict: "accepted",
    identityReason: null,
    fetchState: "fetched",
    ...over,
  };
}

function addDoc(filingId: number, fileName: string, docType: string, seq: number, html: string): void {
  const path = `/virtual/${filingId}/${fileName}`;
  files.set(path, html);
  upsertDocument(db, {
    filingId, fileName, docType, sequence: seq, status: "fetched",
    skipReason: null, sha256: null, byteLen: html.length, storedPath: path,
  });
}

function seedEarnings(accession = "0000000001-26-000001"): number {
  const { id } = insertFiling(db, filing(accession));
  addDoc(id, "ex991.htm", "EX-99.1", 2, EX991_HTML);
  upsertDocument(db, {
    filingId: id, fileName: "logo.jpg", docType: "GRAPHIC", sequence: 3, status: "skipped",
    skipReason: "graphic", sha256: null, byteLen: null, storedPath: null,
  });
  return id;
}

function seedCompanion(accession: string): number {
  const { id } = insertFiling(
    db,
    filing(accession, { form: "PRE 14C", role: "companion", items: null, acceptedAt: "2026-10-22T20:10:00.000Z" }),
  );
  addDoc(id, "pre14c.htm", "PRE 14C", 1, PRE14C_HTML);
  return id;
}

function output(headline: string, quote: string, document: string, claimText = "Revenue rose.") {
  return {
    headline,
    bullets: [
      {
        top: true,
        routine: false,
        claims: [
          {
            id: "c1",
            text: claimText,
            citations: [{ id: "q1", document, quote, isTableRow: false }],
            figures: [],
            comparisons: [],
            corrects: null,
          },
        ],
      },
    ],
  };
}

const EARNINGS_OUT = output("Revenue beat", "Revenue rose sharply in the quarter.", "ex991.htm");
const COMPANION_OUT = output("Share class change", "The board approved a share class conversion.", "pre14c.htm", "The board approved a conversion.");

type GenArgs = Parameters<RunnerSeams["generate"]>;
function seams(generate: (...a: GenArgs) => Promise<unknown>, over: Partial<RunnerSeams> = {}) {
  const onSectionDone = vi.fn(async () => {});
  const gen = vi.fn(generate);
  const s: Partial<RunnerSeams> = {
    generate: gen as unknown as RunnerSeams["generate"],
    readDocument: (p: string) => files.get(p) ?? null,
    now: () => T0,
    token: () => `tok-${++tokenN}`,
    onSectionDone,
    ...over,
  };
  return { s, gen, onSectionDone };
}

const ok = (object: unknown) => async () => ({
  object,
  usage: { inputTokens: 1200, outputTokens: 340, reasoningTokens: 90, totalTokens: 1540 },
  finishReason: "stop",
});

function sectionsOf(runId: number) {
  return listSections(db, runId);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  eventId = seedEvent("SYNW", "k1");
  files = new Map();
  tokenN = 0;
  setModelCatalogSource(() => CATALOG);
});

afterEach(() => {
  setModelCatalogSource(null);
});

describe("startRun", () => {
  it("freezes the filing list (earnings first, then companions) and the pinned model", () => {
    seedCompanion("0000000001-26-000009"); // found first, still ordered after the earnings filing
    const earnings = seedEarnings();
    const r = startRun(db, eventId, "auto", { catalogIds: CATALOG });
    expect(r).toMatchObject({ ok: true, created: true });
    const run = listRuns(db, eventId)[0];
    expect(run.modelId).toBe("claude-opus-5-5");
    expect(run.effort).toBe("high");
    expect(run.fallbackNote).toBeNull();
    const secs = sectionsOf(run.id);
    expect(secs.map((s) => s.filingId)[0]).toBe(earnings);
    expect(secs).toHaveLength(2);
  });

  it("the same request key twice gives one run; another event's key is refused", () => {
    seedEarnings();
    const a = startRun(db, eventId, "rerun", { requestKey: "rk-1", catalogIds: CATALOG });
    const b = startRun(db, eventId, "rerun", { requestKey: "rk-1", catalogIds: CATALOG });
    expect(a).toMatchObject({ ok: true, created: true });
    expect(b).toEqual({ ok: true, runId: (a as { runId: number }).runId, created: false });
    expect(listRuns(db, eventId)).toHaveLength(1);

    const other = seedEvent("OTHR", "k2");
    expect(startRun(db, other, "rerun", { requestKey: "rk-1", catalogIds: CATALOG })).toEqual({
      ok: false,
      reason: "request_key_conflict",
    });
  });

  it("records a down-ladder fallback and refuses with no model or no filings", () => {
    expect(startRun(db, eventId, "auto", { catalogIds: CATALOG })).toEqual({ ok: false, reason: "no_filings" });
    seedEarnings();
    expect(startRun(db, eventId, "auto", { catalogIds: [] })).toEqual({ ok: false, reason: "no_model" });
    expect(listRuns(db, eventId)).toHaveLength(0);
    startRun(db, eventId, "manual_run", { choice: { family: "fable", effort: "high" }, catalogIds: CATALOG });
    expect(listRuns(db, eventId)[0].fallbackNote).toBe("Fable unavailable — Opus 5.5 ran instead");
    expect(startRun(db, 99_999, "auto", { catalogIds: CATALOG })).toEqual({ ok: false, reason: "not_found" });
  });

  it("a time-unconfirmed earnings filing: an owner click reads it, an automatic run never does (round 2 ruling)", () => {
    const { id } = insertFiling(
      db,
      filing("0000000001-26-000001", {
        acceptedAt: null,
        identityVerdict: "time_unconfirmed",
        identityReason: "header has no acceptance time",
        gatePassed: true,
      }),
    );
    addDoc(id, "ex991.htm", "EX-99.1", 2, EX991_HTML);
    expect(startRun(db, eventId, "auto", { catalogIds: CATALOG })).toEqual({ ok: false, reason: "no_filings" });
    onEarningsAccepted(db, eventId);
    expect(listRuns(db, eventId)).toHaveLength(0);

    const r = startRun(db, eventId, "manual_run", { requestKey: "rk-manual", catalogIds: CATALOG });
    expect(r.ok).toBe(true);
    const runs = listRuns(db, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("manual_run");
    expect(sectionsOf(runs[0].id).map((s) => s.filingId)).toEqual([id]);

    // A re-run of that run reads the same filing (also an owner click).
    expect(startRun(db, eventId, "rerun", { requestKey: "rk-rerun", catalogIds: CATALOG }).ok).toBe(true);
  });

  it("manual_run refuses an untimed earnings filing that has not passed the gate (round 3 ruling)", () => {
    const { id } = insertFiling(
      db,
      filing("0000000001-26-000001", { acceptedAt: null, identityVerdict: "time_unconfirmed", gatePassed: false }),
    );
    addDoc(id, "ex991.htm", "EX-99.1", 2, EX991_HTML);
    expect(startRun(db, eventId, "manual_run", { requestKey: "rk-ng", catalogIds: CATALOG })).toEqual({
      ok: false,
      reason: "no_filings",
    });
    // An untimed one whose gate failed (ambiguous) is refused too.
    db.prepare("UPDATE filing_summary_filings SET identity_verdict = 'ambiguous' WHERE id = ?").run(id);
    expect(startRun(db, eventId, "manual_run", { requestKey: "rk-amb", catalogIds: CATALOG }).ok).toBe(false);
    expect(listRuns(db, eventId)).toHaveLength(0);
  });

  it("an accepted earnings filing is preferred over a time-unconfirmed one on a manual run", () => {
    insertFiling(db, filing("0000000001-26-000001", { acceptedAt: null, identityVerdict: "time_unconfirmed", role: "companion" }));
    const accepted = seedEarnings("0000000001-26-000002");
    startRun(db, eventId, "manual_run", { requestKey: "rk-m", catalogIds: CATALOG });
    expect(sectionsOf(listRuns(db, eventId)[0].id).map((s) => s.filingId)).toEqual([accepted]);
  });

  it("onEarningsAccepted starts one auto run, never for a manual-only event", () => {
    seedEarnings();
    upsertEventState(db, eventId, { pollState: "manual_only" });
    onEarningsAccepted(db, eventId);
    expect(listRuns(db, eventId)).toHaveLength(0);
  });

  it("onEarningsAccepted keys the run per filing: a repeat is a no-op, a new accepted filing runs", () => {
    const first = seedEarnings();
    onEarningsAccepted(db, eventId);
    onEarningsAccepted(db, eventId); // a re-arm or a second poll
    let runs = listRuns(db, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "auto", requestKey: autoRunKey(eventId, first) });

    // The first earnings filing is rejected; a corrected one is accepted later.
    db.prepare("UPDATE filing_summary_filings SET identity_verdict = 'rejected' WHERE id = ?").run(first);
    const second = seedEarnings("0000000001-26-000042");
    onEarningsAccepted(db, eventId);
    runs = listRuns(db, eventId);
    expect(runs).toHaveLength(2);
    expect(runs[1].requestKey).toBe(autoRunKey(eventId, second));
    expect(sectionsOf(runs[1].id)[0].filingId).toBe(second);
  });
});

describe("ensureAutoRun (final review minor)", () => {
  it("an accepted earnings filing whose auto start found no model is started on the next tick, once, under the same key", () => {
    const filingId = seedEarnings();
    upsertEventState(db, eventId, { pollState: "found" });
    setModelCatalogSource(() => []);
    onEarningsAccepted(db, eventId); // no_model: nothing created
    expect(listRuns(db, eventId)).toHaveLength(0);
    ensureAutoRun(db, eventId, T0); // still no model
    expect(listRuns(db, eventId)).toHaveLength(0);

    setModelCatalogSource(() => CATALOG);
    ensureAutoRun(db, eventId, T0);
    ensureAutoRun(db, eventId, T0);
    const runs = listRuns(db, eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "auto", requestKey: autoRunKey(eventId, filingId) });
  });

  it("never starts for a manual_only event, an event with a run, or a waiting event", () => {
    seedEarnings();
    upsertEventState(db, eventId, { pollState: "manual_only" });
    ensureAutoRun(db, eventId, T0);
    upsertEventState(db, eventId, { pollState: "waiting" });
    ensureAutoRun(db, eventId, T0);
    expect(listRuns(db, eventId)).toHaveLength(0);
    upsertEventState(db, eventId, { pollState: "found" });
    startRun(db, eventId, "manual_run", { requestKey: "rk-x", catalogIds: CATALOG });
    ensureAutoRun(db, eventId, T0);
    expect(listRuns(db, eventId)).toHaveLength(1);
  });

  it("past_cutoff retries only on the print's own Eastern day", () => {
    seedEarnings();
    upsertEventState(db, eventId, { pollState: "past_cutoff" });
    ensureAutoRun(db, eventId, Date.parse("2026-10-24T15:00:00Z"));
    expect(listRuns(db, eventId)).toHaveLength(0);
    ensureAutoRun(db, eventId, T0); // 2026-10-22 16:30 Eastern
    expect(listRuns(db, eventId)).toHaveLength(1);
  });
});

describe("runNextSection", () => {
  function start(): number {
    const r = startRun(db, eventId, "auto", { catalogIds: CATALOG });
    if (!r.ok) throw new Error(r.reason);
    return r.runId;
  }

  it("happy path: checked, coverage, usage, versions, run done, hook once", async () => {
    seedEarnings();
    const runId = start();
    const { s, gen, onSectionDone } = seams(ok(EARNINGS_OUT));
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(gen).toHaveBeenCalledTimes(1);
    const [feature, target, opts] = gen.mock.calls[0];
    expect(feature).toBe("printFilingSummary");
    expect(target).toEqual({ modelId: "claude-opus-5-5", effort: "high", family: "opus" });
    expect(opts.maxOutputTokens).toBe(64000);

    const sec = sectionsOf(runId)[0];
    expect(sec.status).toBe("done");
    const checked = JSON.parse(sec.checkedJson!) as CheckedSection;
    expect(checked.headline).toBe("Revenue beat");
    expect(checked.claims[0].claimId).toBe("s1.c1");
    expect(checked.claims[0].status).toBe("qualitative");
    const coverage = JSON.parse(sec.coverageJson!) as CoverageEntry[];
    expect(coverage).toEqual([
      { fileName: "ex991.htm", docType: "EX-99.1", status: "read", reason: null },
      { fileName: "logo.jpg", docType: "GRAPHIC", status: "skipped", reason: "not text (image or XBRL)" },
    ]);
    // A routine skip (a graphic) is listed but leaves nothing out.
    expect(sec.incomplete).toBe(false);
    expect(JSON.parse(sec.usageJson!)).toEqual({ inputTokens: 1200, outputTokens: 340, reasoningTokens: 90 });
    expect(JSON.parse(sec.versionsJson!)).toEqual({
      schema: SCHEMA_VERSION, prompt: PROMPT_VERSION, extractor: EXTRACTOR_VERSION, checker: CHECKER_VERSION,
    });
    expect(sec.modelId).toBe("claude-opus-5-5");
    expect(sec.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(listRuns(db, eventId)[0].status).toBe("done");
    expect(onSectionDone).toHaveBeenCalledTimes(1);
    expect(await runNextSection(db, eventId, s)).toBe("idle");
  });

  it("a refusal fails the section with no second call", async () => {
    seedEarnings();
    const runId = start();
    const { s, gen, onSectionDone } = seams(async () => {
      throw new AIRefusalError("printFilingSummary", "claude-opus-5-5");
    });
    await runNextSection(db, eventId, s);
    expect(await runNextSection(db, eventId, s)).toBe("idle");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "refusal", attempts: 1 });
    expect(listRuns(db, eventId)[0].status).toBe("failed");
    expect(onSectionDone).not.toHaveBeenCalled();
  });

  it("a truncation fails as truncated; a lost model as model_unavailable", async () => {
    seedEarnings();
    const runId = start();
    const { s, gen } = seams(async () => {
      throw new AITruncatedError("printFilingSummary", "claude-opus-5-5");
    });
    await runNextSection(db, eventId, s);
    expect(await runNextSection(db, eventId, s)).toBe("idle");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "truncated" });

    const ev2 = seedEvent("GONE", "k3");
    eventId = ev2;
    seedEarnings("0000000001-26-000077");
    const run2 = start();
    const { s: s2 } = seams(async () => {
      throw new AIModelUnavailableError("printFilingSummary", "claude-opus-5-5");
    });
    await runNextSection(db, eventId, s2);
    expect(sectionsOf(run2)[0]).toMatchObject({
      status: "failed",
      errorClass: "model_unavailable",
      errorText: "model no longer available — re-run",
    });
  });

  it("a truncated or refused call keeps its usage on the failed section (the cost line counts it)", async () => {
    seedEarnings();
    const runId = start();
    const { s } = seams(async () => {
      throw new AITruncatedError("printFilingSummary", "claude-opus-5-5", {
        inputTokens: 40000, outputTokens: 64000, reasoningTokens: 51000, totalTokens: 104000,
      });
    });
    await runNextSection(db, eventId, s);
    const sec = sectionsOf(runId)[0];
    expect(sec).toMatchObject({ status: "failed", errorClass: "truncated" });
    expect(JSON.parse(sec.usageJson!)).toEqual({ inputTokens: 40000, outputTokens: 64000, reasoningTokens: 51000 });

    eventId = seedEvent("RFSD", "k9");
    seedEarnings("0000000001-26-000099");
    const run2 = start();
    const { s: s2 } = seams(async () => {
      throw new AIRefusalError("printFilingSummary", "claude-opus-5-5", { inputTokens: 900, outputTokens: 12 });
    });
    await runNextSection(db, eventId, s2);
    const sec2 = sectionsOf(run2)[0];
    expect(sec2).toMatchObject({ status: "failed", errorClass: "refusal" });
    expect(JSON.parse(sec2.usageJson!)).toEqual({ inputTokens: 900, outputTokens: 12 });
  });

  it("a truncation with no usage reported stores no usage", async () => {
    seedEarnings();
    const runId = start();
    const { s } = seams(async () => {
      throw new AITruncatedError("printFilingSummary", "claude-opus-5-5");
    });
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0].usageJson).toBeNull();
  });

  it("pins the call budget: 64k output tokens, a 10-minute timeout", () => {
    expect(SECTION_CALL_TIMEOUT_MS).toBe(600_000);
    expect(SECTION_MAX_OUTPUT_TOKENS).toBe(64_000);
  });

  it("a live call open for 9 minutes is never taken over: the heartbeat keeps it fresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      seedEarnings();
      const runId = start();
      let clock = T0;
      let finish!: () => void;
      const { s } = seams(
        async () => {
          await new Promise<void>((resolve) => { finish = resolve; });
          return ok(EARNINGS_OUT)();
        },
        { now: () => clock },
      );
      const pending = runNextSection(db, eventId, s);
      await Promise.resolve();
      for (let minute = 1; minute <= 9; minute++) {
        clock = T0 + minute * MIN;
        vi.advanceTimersByTime(60_000);
        // Another worker looks for stale work at each minute: nothing to take.
        expect(claimNextSection(db, eventId, "tok-B", clock)).toBeNull();
      }
      expect(SECTION_CALL_TIMEOUT_MS).toBeGreaterThan(9 * MIN);
      finish();
      expect(await pending).toBe("ran");
      expect(sectionsOf(runId)[0]).toMatchObject({ status: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a timeout then a success: done with attempts = 2", async () => {
    seedEarnings();
    const runId = start();
    let n = 0;
    const { s, gen } = seams(async () => {
      if (++n === 1) {
        const e = new Error("timed out");
        e.name = "TimeoutError";
        throw e;
      }
      return ok(EARNINGS_OUT)();
    });
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", errorClass: "timeout" });
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(gen).toHaveBeenCalledTimes(2);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "done", attempts: 2, errorClass: null });
  });

  it("two failures end at attempt_cap with the last class; invalid output counts as one", async () => {
    seedEarnings();
    const runId = start();
    let n = 0;
    const { s, gen } = seams(async () => {
      if (++n === 1) return ok({ headline: 7 })();
      throw new Error("upstream 500 with a body that must never be stored");
    });
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", errorClass: "invalid_output" });
    await runNextSection(db, eventId, s);
    expect(await runNextSection(db, eventId, s)).toBe("idle");
    expect(gen).toHaveBeenCalledTimes(2);
    const sec = sectionsOf(runId)[0];
    expect(sec).toMatchObject({ status: "failed", errorClass: "attempt_cap", errorText: "model_error" });
    expect(JSON.stringify(sec)).not.toContain("must never be stored");
  });

  it("a claim past the cap (a takeover after two attempts) fails without a call", async () => {
    seedEarnings();
    const runId = start();
    db.prepare("UPDATE filing_summary_sections SET attempts = 2 WHERE run_id = ?").run(runId);
    const { s, gen } = seams(ok(EARNINGS_OUT));
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(gen).not.toHaveBeenCalled();
    expect(sectionsOf(runId)[0]).toMatchObject({
      status: "failed", errorClass: "attempt_cap", errorText: "takeover", attempts: 3,
    });
  });

  it("a rejected filing is cancelled without a call", async () => {
    const id = seedEarnings();
    const runId = start();
    db.prepare("UPDATE filing_summary_filings SET identity_verdict = 'rejected' WHERE id = ?").run(id);
    const { s, gen } = seams(ok(EARNINGS_OUT));
    await runNextSection(db, eventId, s);
    expect(gen).not.toHaveBeenCalled();
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "cancelled" });
  });

  it("a stale worker whose claim was taken over writes nothing", async () => {
    seedEarnings();
    const runId = start();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { s } = seams(async () => {
      await gate;
      return ok(EARNINGS_OUT)();
    });
    const pending = runNextSection(db, eventId, s);
    await new Promise((r) => setTimeout(r, 0));
    // Worker B takes over after the stale window.
    const b = claimNextSection(db, eventId, "tok-B", T0 + 10 * MIN);
    expect(b?.attempts).toBe(2);
    release();
    expect(await pending).toBe("lost_claim");
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "running", claimToken: "tok-B", checkedJson: null });
  });

  describe("incomplete: routine skips are listed, only a left-out document counts (browser pass ruling)", () => {
    function skipped(filingId: number, fileName: string, docType: string, seq: number, status: "skipped" | "failed", reason: string): void {
      upsertDocument(db, {
        filingId, fileName, docType, sequence: seq, status,
        skipReason: reason, sha256: null, byteLen: null, storedPath: null,
      });
    }

    async function runOne(): Promise<{ incomplete: boolean; coverage: CoverageEntry[] }> {
      const runId = start();
      const { s } = seams(ok(EARNINGS_OUT));
      await runNextSection(db, eventId, s);
      const sec = sectionsOf(runId)[0];
      return { incomplete: sec.incomplete, coverage: JSON.parse(sec.coverageJson!) as CoverageEntry[] };
    }

    it("graphics, XBRL parts, XML/JSON/ZIP and images do not make a section incomplete", async () => {
      const id = seedEarnings();
      skipped(id, "meta-20261021.xsd", "EX-101.SCH", 4, "skipped", "skipped: XBRL part (EX-101.SCH)");
      skipped(id, "R1.htm", "XML", 5, "skipped", "skipped: XML document");
      skipped(id, "report.css", "XML", 6, "skipped", "skipped: XML document");
      skipped(id, "FilingSummary.json", "JSON", 7, "skipped", "skipped: JSON document");
      skipped(id, "0000000001-26-000001-xbrl.zip", "ZIP", 8, "skipped", "skipped: ZIP document");
      skipped(id, "chart.png", "EX-99.3", 9, "skipped", "skipped: .png file");
      const { incomplete, coverage } = await runOne();
      expect(incomplete).toBe(false);
      const routine = coverage.filter((c) => c.status === "skipped");
      expect(routine).toHaveLength(7);
      for (const c of routine) expect(c.reason).toBe(ROUTINE_SKIP_REASON);
    });

    it("a failed fetch makes the section incomplete", async () => {
      const id = seedEarnings();
      skipped(id, "ex992.htm", "EX-99.2", 4, "failed", "fetch failed");
      const { incomplete, coverage } = await runOne();
      expect(incomplete).toBe(true);
      expect(coverage.find((c) => c.fileName === "ex992.htm")).toMatchObject({ status: "failed", reason: "fetch failed" });
    });

    it("an oversized document makes the section incomplete", async () => {
      const id = seedEarnings();
      skipped(id, "ex992.htm", "EX-99.2", 4, "skipped", "over the per-document size cap");
      const { incomplete, coverage } = await runOne();
      expect(incomplete).toBe(true);
      expect(coverage.find((c) => c.fileName === "ex992.htm")?.reason).toBe("over the per-document size cap");
    });

    it("a filing whose fetch failed is incomplete even when every stored document was read", async () => {
      const { id } = insertFiling(db, filing("0000000001-26-000003", { fetchState: "failed" }));
      addDoc(id, "ex991.htm", "EX-99.1", 1, EX991_HTML);
      const { incomplete } = await runOne();
      expect(incomplete).toBe(true);
    });
  });

  it("the input cap skips later documents in sequence order and marks the section incomplete", async () => {
    const { id } = insertFiling(db, filing("0000000001-26-000002"));
    const big = (n: number) => `<html><body><p>${"word ".repeat(n)}</p></body></html>`;
    addDoc(id, "ex991.htm", "EX-99.1", 1, big(Math.floor((INPUT_CAP_CHARS * 0.7) / 5)));
    addDoc(id, "ex992.htm", "EX-99.2", 2, big(Math.floor((INPUT_CAP_CHARS * 0.5) / 5)));
    const runId = start();
    const { s, gen } = seams(ok(EARNINGS_OUT));
    await runNextSection(db, eventId, s);
    const sec = sectionsOf(runId)[0];
    const coverage = JSON.parse(sec.coverageJson!) as CoverageEntry[];
    expect(coverage.map((c) => [c.fileName, c.status, c.reason])).toEqual([
      ["ex991.htm", "read", null],
      ["ex992.htm", "skipped", "over the input cap"],
    ]);
    expect(sec.incomplete).toBe(true);
    expect((gen.mock.calls[0][2].prompt as string).length).toBeLessThan(INPUT_CAP_CHARS + 50_000);
  });

  it("a filing rejected while the call ran ends failed/cancelled, usage kept, no hook", async () => {
    const id = seedEarnings();
    const runId = start();
    const { s, onSectionDone } = seams(async () => {
      db.prepare("UPDATE filing_summary_filings SET identity_verdict = 'rejected' WHERE id = ?").run(id);
      return ok(EARNINGS_OUT)();
    });
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    const sec = sectionsOf(runId)[0];
    expect(sec).toMatchObject({ status: "failed", errorClass: "cancelled", errorText: "filing no longer matches the print", checkedJson: null });
    expect(JSON.parse(sec.usageJson!)).toMatchObject({ inputTokens: 1200, outputTokens: 340 });
    expect(onSectionDone).not.toHaveBeenCalled();
    expect(listRuns(db, eventId)[0].status).toBe("failed");
  });

  it("a lost model fails the run's other pending sections; Retry leaves them; Re-run is the remedy", async () => {
    seedEarnings();
    seedCompanion("0000000001-26-000011");
    const runId = start();
    const { s, gen } = seams(async () => {
      throw new AIModelUnavailableError("printFilingSummary", "claude-opus-5-5");
    });
    await runNextSection(db, eventId, s);
    expect(await runNextSection(db, eventId, s)).toBe("idle");
    expect(gen).toHaveBeenCalledTimes(1);
    expect(sectionsOf(runId).map((x) => [x.status, x.errorClass, x.errorText])).toEqual([
      ["failed", "model_unavailable", "model no longer available — re-run"],
      ["failed", "model_unavailable", "model no longer available — re-run"],
    ]);
    expect(listRuns(db, eventId)[0].status).toBe("failed");
    expect(retryRunWithReason(db, runId, "r-a")).toEqual({ ok: false, reason: "nothing_to_retry" });
  });

  it("Retry is refused while the event is cancelled", async () => {
    seedEarnings();
    const runId = start();
    await runNextSection(db, eventId, seams(async () => {
      throw new AIRefusalError("printFilingSummary", "claude-opus-5-5");
    }).s);
    upsertEventState(db, eventId, { pollState: "cancelled" });
    expect(retryRunWithReason(db, runId, "r-b")).toEqual({ ok: false, reason: "event_cancelled" });
    expect(retryRun(db, 424242, "r-c")).toBe(false);
  });

  it("a failed heartbeat aborts the call in flight", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      seedEarnings();
      const runId = start();
      let sawAbort = false;
      const { s } = seams(async (_f, _t, opts) => {
        const signal = opts.abortSignal as AbortSignal;
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
        return ok(EARNINGS_OUT)();
      });
      const pending = runNextSection(db, eventId, s);
      // Another worker takes over: this worker's next heartbeat fails.
      claimNextSection(db, eventId, "tok-B", T0 + 10 * MIN);
      vi.advanceTimersByTime(60_000);
      expect(await pending).toBe("lost_claim");
      expect(sawAbort).toBe(true);
      expect(sectionsOf(runId)[0]).toMatchObject({ status: "running", claimToken: "tok-B" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("I1: a heartbeat that throws neither rejects nor crashes; the call finishes and is finalized", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      seedEarnings();
      const runId = start();
      let explode = false;
      let finish!: () => void;
      const { s } = seams(
        async () => {
          await new Promise<void>((resolve) => { finish = resolve; });
          return ok(EARNINGS_OUT)();
        },
        {
          now: () => {
            if (explode) throw new Error("database is locked");
            return T0;
          },
        },
      );
      const pending = runNextSection(db, eventId, s);
      await Promise.resolve();
      explode = true;
      // Without the guard this throws out of the timer (an uncaught exception in production).
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
      explode = false;
      finish();
      expect(await pending).toBe("ran");
      expect(sectionsOf(runId)[0]).toMatchObject({ status: "done" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the prompt carries none of the privacy canaries", async () => {
    db.prepare(`INSERT INTO accounts (name) VALUES ('CANARY-ACCOUNT')`).run();
    db.prepare(
      `INSERT INTO earnings_bogeys (event_id, source, source_label, uploaded_at, eps_consensus, revenue_consensus_usd, notes, guidance_notes)
       VALUES (?, 'manual', 'CANARY-LABEL', '2026-10-21 15:00:00', 2.1, 50000000000, 'CANARY-NOTES-7731', 'CANARY-NOTES-7731')`,
    ).run(eventId);
    seedEarnings();
    start();
    const { s, gen } = seams(ok(EARNINGS_OUT));
    await runNextSection(db, eventId, s);
    const opts = gen.mock.calls[0][2];
    const text = `${opts.system}\n${opts.prompt}`;
    expect(text).not.toMatch(/CANARY/);
    expect(text).toContain("your manual entry");
  });
});

describe("companions (R13)", () => {
  it("a companion found during a re-run lands on the re-run and reads its earnings section", async () => {
    seedEarnings();
    const first = startRun(db, eventId, "auto", { catalogIds: CATALOG });
    const { s } = seams(ok(EARNINGS_OUT));
    await runNextSection(db, eventId, s);
    const rerun = startRun(db, eventId, "rerun", { requestKey: "rk-2", catalogIds: CATALOG });
    if (!first.ok || !rerun.ok) throw new Error("setup");

    const comp = seedCompanion("0000000001-26-000003");
    const sectionId = appendCompanion(db, eventId, comp);
    expect(sectionId).not.toBeNull();
    expect(sectionsOf(rerun.runId).map((x) => x.filingId).at(-1)).toBe(comp);
    expect(sectionsOf(first.runId)).toHaveLength(1);

    let n = 0;
    const { s: s2, gen } = seams(async () => ok(++n === 1 ? EARNINGS_OUT : COMPANION_OUT)());
    await runNextSection(db, eventId, s2); // the re-run's earnings section first
    await runNextSection(db, eventId, s2); // then the companion
    const secs = sectionsOf(rerun.runId);
    expect(secs.map((x) => x.status)).toEqual(["done", "done"]);
    const companionPrompt = gen.mock.calls[1][2].prompt as string;
    expect(companionPrompt).toContain("EARLIER SECTIONS");
    expect(companionPrompt).toContain("headline: Revenue beat");
    expect(companionPrompt).toContain("[s1.c1]");
    const checked = JSON.parse(secs[1].checkedJson!) as CheckedSection;
    expect(checked.claims[0].claimId).toBe("s2.c1");
  });

  it("when the newest run failed, a companion goes to the newest done run", async () => {
    seedEarnings();
    startRun(db, eventId, "auto", { catalogIds: CATALOG });
    await runNextSection(db, eventId, seams(ok(EARNINGS_OUT)).s);
    const rerun = startRun(db, eventId, "rerun", { requestKey: "rk-3", catalogIds: CATALOG });
    await runNextSection(db, eventId, seams(async () => {
      throw new AIRefusalError("printFilingSummary", "claude-opus-5-5");
    }).s);
    const runs = listRuns(db, eventId);
    expect(runs.map((r) => r.status)).toEqual(["done", "failed"]);

    const comp = seedCompanion("0000000001-26-000004");
    appendCompanion(db, eventId, comp);
    expect(sectionsOf(runs[0].id).map((x) => x.filingId)).toContain(comp);
    expect(listRuns(db, eventId)[0].status).toBe("running");
    if (!rerun.ok) throw new Error("setup");
    expect(sectionsOf(rerun.runId)).toHaveLength(1);
  });

  it("with no done run, the companion waits in the failed run until Retry", async () => {
    seedEarnings();
    const r = startRun(db, eventId, "auto", { catalogIds: CATALOG });
    if (!r.ok) throw new Error("setup");
    await runNextSection(db, eventId, seams(async () => {
      throw new AITruncatedError("printFilingSummary", "claude-opus-5-5");
    }).s);
    const comp = seedCompanion("0000000001-26-000005");
    appendCompanion(db, eventId, comp);
    expect(sectionsOf(r.runId)[1]).toMatchObject({ status: "failed", errorClass: "awaiting_retry" });
    const idle = seams(ok(EARNINGS_OUT));
    expect(await runNextSection(db, eventId, idle.s)).toBe("idle");
    expect(idle.gen).not.toHaveBeenCalled();
    expect(listRuns(db, eventId)[0].status).toBe("failed");

    expect(retryRun(db, r.runId, "retry-1")).toBe(true);
    expect(retryRun(db, r.runId, "retry-1")).toBe(true); // same click: no second reset
    expect(sectionsOf(r.runId).map((x) => [x.status, x.attempts])).toEqual([
      ["pending", 0],
      ["pending", 0],
    ]);
    let n = 0;
    const { s, gen } = seams(async () => ok(++n === 1 ? EARNINGS_OUT : COMPANION_OUT)());
    await runNextSection(db, eventId, s);
    await runNextSection(db, eventId, s);
    expect(gen).toHaveBeenCalledTimes(2);
    expect(listRuns(db, eventId)[0].status).toBe("done");
    expect(retryRunWithReason(db, r.runId, "retry-2")).toEqual({ ok: false, reason: "nothing_to_retry" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'filing_summary%'").get()).toEqual({ n: 0 });
  });
});

/**
 * Owner ruling (2026-10-27 precedent, 2026-10-29 incident): an AI ACCOUNT
 * failure (out of credit, spend cap, bad key, rate limit, provider outage,
 * no connection) never spends a section's attempt. The section waits as
 * pending and the next tick tries again; any other failure counts as before.
 * The errors come from the real AI SDK with only the network stubbed, with
 * the gateway's own `maxRetries: 0`.
 */
describe("an AI account failure never spends an attempt (2026-10-29)", () => {
  function start(): number {
    const r = startRun(db, eventId, "auto", { catalogIds: CATALOG });
    if (!r.ok) throw new Error(r.reason);
    return r.runId;
  }
  async function sdkError(name: AnthropicFailureName): Promise<unknown> {
    return (await errorFromRealSdk(ANTHROPIC_FAILURES[name], { maxRetries: 0 })).error;
  }

  it("the spend cap: five failed ticks leave the section pending with no attempt spent; it then runs", async () => {
    seedEarnings();
    const runId = start();
    const capped = await sdkError("spendLimit400");
    let n = 0;
    const { s, gen } = seams(async () => {
      if (++n <= 5) throw capped;
      return ok(EARNINGS_OUT)();
    });
    for (let i = 0; i < 5; i++) {
      expect(await runNextSection(db, eventId, s)).toBe("ran");
      const sec = sectionsOf(runId)[0];
      expect(sec).toMatchObject({ status: "pending", attempts: 0, errorClass: "model_error" });
      expect(sec.errorText?.startsWith(AI_UNAVAILABLE_REASON_PREFIX)).toBe(true);
    }
    expect(listRuns(db, eventId)[0].status).toBe("running");
    expect(await runNextSection(db, eventId, s)).toBe("ran");
    expect(gen).toHaveBeenCalledTimes(6);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "done", attempts: 1, errorClass: null, errorText: null });
  });

  it.each<AnthropicFailureName>(["billing400", "billing402", "rateLimit429", "overloaded529", "apiError500", "auth401"])(
    "%s is free: never attempt_cap",
    async (name) => {
      seedEarnings();
      const runId = start();
      const err = await sdkError(name);
      const { s } = seams(async () => {
        throw err;
      });
      for (let i = 0; i < 3; i++) await runNextSection(db, eventId, s);
      expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", attempts: 0 });
    },
  );

  it("no connection is free", async () => {
    seedEarnings();
    const runId = start();
    const err = (await errorFromRealSdk(() => { throw fetchFailed(); }, { maxRetries: 0 })).error;
    const { s } = seams(async () => {
      throw err;
    });
    for (let i = 0; i < 3; i++) await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a request-level failure still counts; an outage between two counts does not", async () => {
    seedEarnings();
    const runId = start();
    const tooLong = await sdkError("promptTooLong400");
    const capped = await sdkError("spendLimit400");
    let n = 0;
    const { s, gen } = seams(async () => {
      n += 1;
      throw n === 2 ? capped : tooLong;
    });
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", attempts: 1, errorClass: "model_error", errorText: null });
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", attempts: 1 });
    await runNextSection(db, eventId, s);
    expect(gen).toHaveBeenCalledTimes(3);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "attempt_cap", errorText: "model_error", attempts: 2 });
  });

  it("an outage on the last attempt does not finalize attempt_cap", async () => {
    seedEarnings();
    const runId = start();
    const capped = await sdkError("spendLimit400");
    let n = 0;
    const { s } = seams(async () => {
      n += 1;
      if (n === 1) throw new Error("upstream hiccup");
      if (n === 2) throw capped;
      return ok(EARNINGS_OUT)();
    });
    await runNextSection(db, eventId, s);
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "pending", attempts: 1 });
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "done", attempts: 2 });
  });

  it("a timeout still counts (our clock, not the account)", async () => {
    seedEarnings();
    const runId = start();
    const { s } = seams(async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    });
    await runNextSection(db, eventId, s);
    await runNextSection(db, eventId, s);
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "attempt_cap", errorText: "timeout" });
  });

  it("a takeover still counts: a dead worker's claim is never given back", async () => {
    seedEarnings();
    const runId = start();
    // Two claims by workers that died mid-call (no requeue, no refund).
    claimNextSection(db, eventId, "dead1", T0);
    claimNextSection(db, eventId, "dead2", T0 + 6 * MIN);
    const capped = await sdkError("spendLimit400");
    const { s, gen } = seams(async () => {
      throw capped;
    }, { now: () => T0 + 12 * MIN });
    await runNextSection(db, eventId, s);
    expect(gen).not.toHaveBeenCalled();
    expect(sectionsOf(runId)[0]).toMatchObject({ status: "failed", errorClass: "attempt_cap", errorText: "takeover" });
  });
});
