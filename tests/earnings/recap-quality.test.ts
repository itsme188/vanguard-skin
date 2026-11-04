/**
 * Recap storage / compose defects from the last-20-recaps review (2026-11-03).
 * Each block reproduces the SHAPE of the evidence row it fixes. Invented
 * issuers and figures only: the repo is public.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  archiveEmailBody,
  cloudRowsMissingBody,
  recordCloudSentAudit,
  storeCloudBody,
} from "@/lib/mutations/earnings-emails";
import {
  claimEarningsEmailSlot,
  markEmailSending,
  markEmailSent,
  recordEarningsEmailAudit,
  type ComposeEarningsResult,
} from "@/lib/digest/send-earnings-email";
import { sendEarningsCandidate } from "@/lib/earnings/send-service";
import {
  getRecapReadinessHold,
  isPlaceholderRecap,
  recapBodyProblem,
  REACTION_HOLD_RELEASE_BEFORE_END_MS,
  RECAP_WINDOW_MS,
} from "@/lib/earnings/recap-readiness";
import { debriefMemberBody } from "@/lib/earnings/debrief-send";
import { backfillCloudBodies } from "@/lib/calendar/email-sweep";
import { composeReporterRecap } from "@/lib/earnings/reporter-recap";
import { renderActualsBasisLine } from "@/lib/earnings/actuals-basis";
import { SENT_BY_CLOUD } from "@/lib/earnings/email-states";

let db: Database.Database;

const NOW = new Date("2026-11-02T22:00:00.000Z");
const sqlTs = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);
const agoMin = (m: number) => sqlTs(new Date(NOW.getTime() - m * 60_000));

/** A measured stock reaction: captured after its window ended. */
const MEASURED = JSON.stringify({
  t0_utc: "2026-11-02T20:05:00.000Z",
  window_min: 120,
  captured_at: "2026-11-02T22:10:00.000Z",
  symbol: { t_pre: 100, t_post: 102, delta_pct: 2 },
});

function seed(opts: {
  symbol?: string;
  actual?: string | null;
  enrichedAgoMin?: number | null;
  snapshot?: string | null;
  stamp?: string | null;
  consensus?: string;
}): number {
  const symbol = opts.symbol ?? "ZZA";
  return Number(
    db
      .prepare(
        `INSERT INTO calendar_events (source, event_type, event_date, title, symbol, source_key, week_of,
                                      consensus_estimate, actual_value, enriched_at, reaction_snapshot, manual_actuals_at)
         VALUES ('finnhub','earnings','2026-11-02',?,?,?,'2026-11-02',?,?,?,?,?)`,
      )
      .run(
        `${symbol} earnings`,
        symbol,
        `k:${symbol}:${Math.random()}`,
        opts.consensus ?? "EPS 1.00 · Rev 100M",
        opts.actual === undefined ? "EPS 1.10 · Rev 105M" : opts.actual,
        opts.enrichedAgoMin === null ? null : agoMin(opts.enrichedAgoMin ?? 150),
        opts.snapshot === undefined ? MEASURED : opts.snapshot,
        opts.stamp ?? null,
      ).lastInsertRowid,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const stitched = (n: number) =>
  Array.from({ length: n }, (_, i) => `## Line-by-line metrics\n| Metric | Q${i + 1} |\n\n## The reaction\nbody ${i}`).join("\n\n---\n\n");

// ── Fix 1: replace, don't append (AAPL / HUN shapes) ─────────────────

describe("fix 1: a compose REPLACES the current body; the superseded one is archived", () => {
  it("a later audit write replaces ai_output_md and keeps the old body in earnings_email_versions", () => {
    const id = seed({});
    recordEarningsEmailAudit(db, { eventId: id, phase: "recap", recipient: "a@x", aiInputHash: "h1", aiOutputMd: "## Data Gap Notice\ndraft", error: null });
    recordEarningsEmailAudit(db, { eventId: id, phase: "recap", recipient: "a@x", aiInputHash: "h2", aiOutputMd: "## Line-by-line metrics\nreal recap", error: null });
    const cur = db.prepare("SELECT ai_output_md FROM earnings_emails WHERE event_id=?").get(id) as { ai_output_md: string };
    expect(cur.ai_output_md).toBe("## Line-by-line metrics\nreal recap"); // replaced, not appended
    expect(cur.ai_output_md).not.toContain("Data Gap Notice");
    const versions = db.prepare("SELECT ai_output_md, reason FROM earnings_email_versions WHERE event_id=?").all(id) as { ai_output_md: string; reason: string }[];
    expect(versions).toHaveLength(1);
    expect(versions[0].ai_output_md).toContain("Data Gap Notice");
  });

  it("a manual refire (markEmailSent) archives the delivered body it replaces", () => {
    const id = seed({});
    db.prepare(`INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error) VALUES (?, 'recap', 'a@x', 'first body', NULL)`).run(id);
    const claim = claimEarningsEmailSlot(db, id, "recap", "a@x", { mode: "manual" });
    expect(claim.claimed).toBe(true);
    markEmailSending(db, id, "recap", claim.token as string, {
      mode: "refire", recipient: "a@x", aiInputHash: "h", aiOutputMd: "second body", providerMessageId: "<m@x>",
      priorError: claim.priorError, priorSentAt: claim.priorSentAt,
    });
    markEmailSent(db, id, "recap", claim.token as string, { recipient: "a@x", aiInputHash: "h", aiOutputMd: "second body", providerResponse: "250 OK" });
    expect((db.prepare("SELECT ai_output_md FROM earnings_emails WHERE event_id=?").get(id) as { ai_output_md: string }).ai_output_md).toBe("second body");
    expect((db.prepare("SELECT ai_output_md FROM earnings_email_versions WHERE event_id=?").get(id) as { ai_output_md: string }).ai_output_md).toBe("first body");
  });

  it("archiving the same body, an empty body, or a cloud row with no body keeps nothing", () => {
    const id = seed({});
    db.prepare(`INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error) VALUES (?, 'recap', 'a@x', 'same', NULL)`).run(id);
    expect(archiveEmailBody(db, id, "recap", "r", "same")).toBe(0);
    expect(archiveEmailBody(db, 99999, "recap", "r")).toBe(0);
    db.prepare(`UPDATE earnings_emails SET ai_output_md = NULL`).run();
    expect(archiveEmailBody(db, id, "recap", "r")).toBe(0);
  });

  it("a stitched body (three quarters, the AAPL shape) or the overnight digest is rejected as a recap body", () => {
    expect(recapBodyProblem(stitched(3))).toMatch(/3 recaps stitched/);
    expect(recapBodyProblem("# What changed overnight\n- bullets")).toMatch(/overnight digest/);
    expect(recapBodyProblem(stitched(1))).toBeNull();
  });
});

// ── Fix 2: no placeholder recaps ─────────────────────────────────────

describe("fix 2: the sweep never sends a recap whose actuals are unconfirmed placeholders", () => {
  const recapComposed = (aiMarkdown: string): ComposeEarningsResult => ({
    symbol: "ZZA", title: "ZZA Earnings Recap", markdown: aiMarkdown, aiMarkdown, html: "<p/>", promptHash: "h",
  });
  const seams = (aiMarkdown: string) => ({
    compose: vi.fn(async () => recapComposed(aiMarkdown)),
    sendEmail: vi.fn(async () => ({ messageId: "x", response: "250 OK" }) as never),
    now: () => NOW,
    markers: { setRunning: async () => {}, clearRunning: async () => {}, writeMacSent: async () => {} },
    checkCloudMarker: async () => null,
  });
  const cand = (id: number) => ({ eventId: id, symbol: "ZZA", phase: "recap" as const });

  it("the HUN / AAPL placeholder markers are recognised; a reaction line alone is not a placeholder", () => {
    expect(isPlaceholderRecap("## Data Gap Notice\nEvery Actual cell reads ⚠️ Not yet confirmed")).toBe(true);
    expect(isPlaceholderRecap("| EPS | 1.00 | ⚠ Not yet captured |")).toBe(true);
    expect(isPlaceholderRecap("## The reaction\nReaction not yet captured.")).toBe(false);
    expect(isPlaceholderRecap("## Line-by-line metrics\nEPS 1.10 vs 1.00")).toBe(false);
  });

  it("actuals flagged implausible (scoreboard blank): the sweep holds, composes nothing, claims nothing", async () => {
    const id = seed({ actual: "EPS 9.99 · Rev 900M" }); // far from consensus: withheld by the plausibility gate
    expect(getRecapReadinessHold(db, id, NOW)).toMatchObject({ held: true, kind: "actuals_unconfirmed" });
    const s = seams("## Line-by-line metrics\nbody");
    const res = await sendEarningsCandidate(db, cand(id), { mode: "sweep", recipient: "a@x", seams: s as never });
    expect(res).toMatchObject({ outcome: "refused", hold: "actuals_unconfirmed", status: 409 });
    expect(s.compose).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_emails").get()).toEqual({ n: 0 });
  });

  it("a desk-stamped actual is the override: never held", () => {
    const id = seed({ actual: "EPS 9.99 · Rev 900M", stamp: "2026-11-02 21:00:00" });
    expect(getRecapReadinessHold(db, id, NOW)).toEqual({ held: false });
  });

  it("a composed Data Gap body is held after compose: the claim is undone so the next tick retries", async () => {
    const id = seed({});
    const s = seams("## Data Gap Notice\nEvery Actual cell: ⚠️ Not yet confirmed");
    const res = await sendEarningsCandidate(db, cand(id), { mode: "sweep", recipient: "a@x", seams: s as never });
    expect(res).toMatchObject({ outcome: "refused", hold: "actuals_unconfirmed" });
    expect(s.sendEmail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM earnings_emails").get()).toEqual({ n: 0 }); // no row: retried next tick
  });

  it("a human's send (nudge) is never held by the placeholder rule", async () => {
    const id = seed({});
    const s = seams("## Data Gap Notice\nplaceholder");
    const res = await sendEarningsCandidate(db, cand(id), { mode: "nudge", recipient: "a@x", seams: s as never });
    expect(res.outcome).toBe("sent");
  });
});

// ── Fix 3: the reaction gate ─────────────────────────────────────────

describe("fix 3: a recap waits for the reaction snapshot (hold-until-snapshot, bounded)", () => {
  it("enriched 30 minutes ago, no snapshot yet: held as reaction_pending", () => {
    const id = seed({ snapshot: null, enrichedAgoMin: 30 });
    expect(getRecapReadinessHold(db, id, NOW)).toMatchObject({ held: true, kind: "reaction_pending" });
  });

  it("a measured stock reaction: not held", () => {
    const id = seed({ snapshot: MEASURED, enrichedAgoMin: 30 });
    expect(getRecapReadinessHold(db, id, NOW)).toEqual({ held: false });
  });

  it("the hold lets go before the 4-hour window closes, so the recap is never silently lost", () => {
    const edge = RECAP_WINDOW_MS - REACTION_HOLD_RELEASE_BEFORE_END_MS;
    const before = seed({ snapshot: null, enrichedAgoMin: edge / 60_000 - 1 });
    const after = seed({ symbol: "ZZB", snapshot: null, enrichedAgoMin: edge / 60_000 + 1 });
    expect(getRecapReadinessHold(db, before, NOW).held).toBe(true);
    expect(getRecapReadinessHold(db, after, NOW)).toEqual({ held: false });
  });

  it("the sweep holds the pending-reaction recap with no claim and no compose", async () => {
    const id = seed({ snapshot: null, enrichedAgoMin: 30 });
    const compose = vi.fn();
    const res = await sendEarningsCandidate(db, { eventId: id, symbol: "ZZA", phase: "recap" }, {
      mode: "sweep", recipient: "a@x", seams: { compose, now: () => NOW, checkCloudMarker: async () => null } as never,
    });
    expect(res).toMatchObject({ outcome: "refused", hold: "reaction_pending" });
    expect(compose).not.toHaveBeenCalled();
  });
});

describe("fix 3: a recap that must go without the reaction says so (subject and first line)", () => {
  it("composeEarningsEmail names the missing reaction in the title and the body; a measured one does not", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ai/provider", () => ({
      getRawAnthropicClient: () => ({
        messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "## Line-by-line metrics\nbody" }] }) },
      }),
    }));
    vi.doMock("@/lib/earnings/intel", async (orig) => ({ ...(await orig<typeof import("@/lib/earnings/intel")>()), ensureIntelForEvents: vi.fn() }));
    const { composeEarningsEmail } = await import("@/lib/digest/send-earnings-email");
    const without = seed({ snapshot: null });
    const withR = seed({ symbol: "ZZC", snapshot: MEASURED });
    const a = await composeEarningsEmail(db, without, "recap");
    expect(a.title).toContain("(reaction not yet captured)");
    expect(a.markdown.split("\n")[0]).toMatch(/Sent before the market reaction was captured/);
    const b = await composeEarningsEmail(db, withR, "recap");
    expect(b.title).not.toContain("reaction not yet captured");
    expect(b.markdown).not.toMatch(/Sent before the market reaction/);
    vi.doUnmock("@/lib/ai/provider");
  });
});

// ── Fix 4: cloud bodies come home ────────────────────────────────────

describe("fix 4: a sent-by-cloud row gets the Worker's composed body", () => {
  it("backfillCloudBodies fills only sent-by-cloud rows that have no body, once", async () => {
    const a = seed({ symbol: "ZZA" });
    const b = seed({ symbol: "ZZB" });
    recordCloudSentAudit(db, a, "recap", "2026-11-02T21:00:00.000Z");
    recordCloudSentAudit(db, b, "recap", "2026-11-02T21:00:00.000Z");
    db.prepare(`UPDATE earnings_emails SET ai_output_md = 'already here' WHERE event_id = ?`).run(b);
    expect(cloudRowsMissingBody(db)).toEqual([{ eventId: a, phase: "recap" }]);
    const fetchBody = vi.fn(async () => ({ subject: "s", markdown: "## ZZA scoreboard — Earnings Recap\ncloud body" }));
    expect(await backfillCloudBodies(db, fetchBody)).toBe(1);
    expect(fetchBody).toHaveBeenCalledTimes(1);
    const rows = db.prepare("SELECT event_id, ai_output_md, error FROM earnings_emails ORDER BY event_id").all() as { event_id: number; ai_output_md: string; error: string }[];
    expect(rows.find((r) => r.event_id === a)).toMatchObject({ ai_output_md: "## ZZA scoreboard — Earnings Recap\ncloud body", error: SENT_BY_CLOUD });
    expect(rows.find((r) => r.event_id === b)?.ai_output_md).toBe("already here"); // a Mac body is never replaced
    expect(await backfillCloudBodies(db, fetchBody)).toBe(0); // idempotent
  });

  it("no body at the Worker (older send, expired key): the row is left as it was", async () => {
    const a = seed({});
    recordCloudSentAudit(db, a, "recap", null);
    expect(await backfillCloudBodies(db, async () => null)).toBe(0);
    expect((db.prepare("SELECT ai_output_md FROM earnings_emails").get() as { ai_output_md: string | null }).ai_output_md).toBeNull();
  });

  it("storeCloudBody refuses an empty body and a non-cloud row", () => {
    const a = seed({});
    db.prepare(`INSERT INTO earnings_emails (event_id, phase, recipient, ai_output_md, error) VALUES (?, 'recap', 'a@x', NULL, NULL)`).run(a);
    expect(storeCloudBody(db, a, "recap", "body")).toBe(0);
    expect(storeCloudBody(db, a, "recap", "  ")).toBe(0);
  });
});

// ── Fix 5: the digest is not a recap ─────────────────────────────────

describe("fix 5: a per-event recap row never holds the overnight digest", () => {
  it("a debrief member stores a pointer plus its own section, not the stitched digest", () => {
    const body = debriefMemberBody("amzn", [
      { symbol: "AMZN", markdown: "## AMZN scoreboard — Earnings Recap\n| EPS | 1.00 |" },
      { symbol: "COIN", markdown: "## COIN scoreboard — Earnings Recap" },
    ]);
    expect(body).toContain("AMZN was covered in the morning debrief");
    expect(body).toContain("AMZN scoreboard");
    expect(body).not.toContain("COIN"); // six events no longer share one body
    expect(recapBodyProblem(body)).toBeNull();
  });
});

// ── Fix 6: scoreboard basis ──────────────────────────────────────────

describe("fix 6: the scoreboard names its basis honestly", () => {
  it("only a vendor figure: the label says no accepted filing figure is on file", () => {
    const line = renderActualsBasisLine({ shownActual: "EPS 1.10 · Rev 105M", manualActualsAt: null, vendorActualValue: null, consensus: "EPS 1.00 · Rev 100M" });
    expect(line).toMatch(/vendor feed only \(no accepted filing figure on file\)/);
  });

  it("an accepted (stamped) figure leads and the label is not 'vendor'", () => {
    const line = renderActualsBasisLine({ shownActual: "EPS 1.10 · Rev 105M", manualActualsAt: "2026-11-02 21:00:00", vendorActualValue: "EPS 1.08 · Rev 105M", consensus: "EPS 1.00 · Rev 100M" });
    expect(line).toMatch(/adjusted/);
    expect(line).not.toMatch(/vendor feed only/);
  });

  it("the read-through reporter recap carries the stamp, so an accepted figure is labelled as such", () => {
    const base = {
      symbol: "HUN", event_date: "2026-11-02", release_time: "16:05", consensus_estimate: "EPS 1.00 · Rev 100M",
      consensus_value: null, actual_value: "EPS 1.10 · Rev 105M", reaction_snapshot: MEASURED,
    };
    const pair = [{ target: "ZZA", nextPrint: null, hypothesis: null, positionLines: [] }] as never;
    const accepted = composeReporterRecap({ ...base, manual_actuals_at: "2026-11-02 21:00:00", vendor_actual_value: "EPS 1.08 · Rev 105M" } as never, pair);
    expect(accepted.markdown).toMatch(/adjusted/);
    const vendor = composeReporterRecap(base as never, pair);
    expect(vendor.markdown).toMatch(/vendor feed only/);
  });
});
