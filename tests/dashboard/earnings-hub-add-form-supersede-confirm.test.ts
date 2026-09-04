/**
 * "+ Add ticker" must not silently override a vendor earnings date
 * (qa:today-earningshub-add-ticker--manual-add-silently-supersedes-vendor-date-other-week).
 *
 * User ruling 2026-09-02 (Option 1): the POST refuses with 409
 * `would_supersede_vendor`, the form explains it in domain language, and a
 * confirm button re-POSTs the same add with `force: true`. UX shape copied
 * from the alerts inbox's `would_fire_immediately` confirm
 * (app/dashboard/alerts/page.tsx) — an inline explanation plus an
 * "arm anyway"-style button, never a dead-end toast.
 *
 * This repo has no React component-rendering harness (no jsdom / happy-dom in
 * vitest.config.ts, no @testing-library — same finding as the sibling file
 * tests/dashboard/earnings-hub-add-form-out-of-week.test.ts). So the network
 * half of the behaviour is extracted into a pure, injectable helper
 * (`postManualEarningsEvent`) and covered for real here — including that the
 * confirm path sends `force: true` — while the JSX wiring is covered by a
 * static scan of the component source, the precedent that file already sets.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { postManualEarningsEvent } from "@/app/dashboard/today/EarningsHubAddForm";

const ADD = { symbol: "ZQTEST", date: "2026-09-02", slot: "AMC" as const };

const REFUSAL_BODY = {
  success: false,
  error:
    "Finnhub already has ZQTEST earnings on 2026-09-07, a different week from the 2026-09-02 you typed. Adding your date replaces the vendor date on the calendar — 2026-09-07 stops showing until you delete the row you are adding.",
  code: "would_supersede_vendor",
  vendorEventId: 41,
  vendorDate: "2026-09-07",
  vendorSource: "finnhub",
};

/** Records every request the helper makes and replies with canned responses. */
function recordingFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({
      url: String(input),
      method: (init?.method ?? "GET").toString(),
      body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
    });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("postManualEarningsEvent — the 409 would_supersede_vendor path", () => {
  it("surfaces the refusal (message + vendor date/source) instead of a generic failure", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: REFUSAL_BODY }]);

    const outcome = await postManualEarningsEvent(ADD, fetchImpl);

    expect(outcome.kind).toBe("supersede_refused");
    if (outcome.kind !== "supersede_refused") throw new Error("unreachable");
    expect(outcome.refusal.message).toBe(REFUSAL_BODY.error);
    expect(outcome.refusal.vendorDate).toBe("2026-09-07");
    expect(outcome.refusal.vendorSource).toBe("finnhub");
    // The refused POST carried no force flag — that is what made it a question.
    expect(calls[0].url).toBe("/api/calendar/events");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body.force).toBeUndefined();
    expect(calls[0].body).toMatchObject({
      symbol: "ZQTEST",
      event_date: "2026-09-02",
      event_time: "AMC",
      event_type: "earnings",
    });
  });

  it("re-POSTs the identical add with force:true when the user confirms", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 409, body: REFUSAL_BODY },
      { status: 200, body: { success: true, id: 77 } },
    ]);

    await postManualEarningsEvent(ADD, fetchImpl);
    const confirmed = await postManualEarningsEvent({ ...ADD, force: true }, fetchImpl);

    expect(confirmed.kind).toBe("saved");
    expect(calls).toHaveLength(2);
    expect(calls[1].body.force).toBe(true);
    // Same add, not a re-typed one.
    expect(calls[1].body.symbol).toBe(calls[0].body.symbol);
    expect(calls[1].body.event_date).toBe(calls[0].body.event_date);
    expect(calls[1].body.event_time).toBe(calls[0].body.event_time);
  });

  it("treats a 409 WITHOUT the supersede code as an ordinary failure (e.g. the duplicate-row 409)", async () => {
    const { fetchImpl } = recordingFetch([
      {
        status: 409,
        body: { error: "A manual calendar event already exists for ZQTEST on 2026-09-02." },
      },
    ]);

    const outcome = await postManualEarningsEvent(ADD, fetchImpl);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.message).toContain("already exists");
  });
});

describe("postManualEarningsEvent — the paths that already worked", () => {
  it("reports saved on a 200 with success:true", async () => {
    const { fetchImpl } = recordingFetch([{ status: 200, body: { success: true, id: 5 } }]);

    const outcome = await postManualEarningsEvent(ADD, fetchImpl);

    expect(outcome).toEqual({ kind: "saved", id: 5 });
  });

  it("fails on a 200 whose body says success:false (res.ok is not enough)", async () => {
    const { fetchImpl } = recordingFetch([
      { status: 200, body: { success: false, error: "Nothing was written." } },
    ]);

    const outcome = await postManualEarningsEvent(ADD, fetchImpl);

    expect(outcome).toEqual({ kind: "failed", message: "Nothing was written." });
  });

  it("fails with the server's message on a 500", async () => {
    const { fetchImpl } = recordingFetch([{ status: 500, body: { error: "boom" } }]);

    expect(await postManualEarningsEvent(ADD, fetchImpl)).toEqual({
      kind: "failed",
      message: "boom",
    });
  });

  it("reports the network error instead of swallowing it", async () => {
    const failing = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const outcome = await postManualEarningsEvent(ADD, failing);

    expect(outcome).toEqual({ kind: "failed", message: "Network error" });
  });

  it("falls back to the status code when the server sends no message at all", async () => {
    const empty = (async () =>
      new Response("not json", { status: 502 })) as unknown as typeof fetch;

    const outcome = await postManualEarningsEvent(ADD, empty);

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("unreachable");
    expect(outcome.message).toContain("502");
  });
});

describe("EarningsHubAddForm — supersede confirm wiring (static scan)", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");

  it("keeps the refusal in its own state, separate from the generic error line", () => {
    expect(src).toMatch(/setSupersede\(/);
    expect(src).toMatch(/outcome\.kind === "supersede_refused"/);
  });

  it("renders the server's plain-English explanation, not raw JSON", () => {
    expect(src).toContain("{supersede.message}");
    expect(src).not.toMatch(/JSON\.stringify\(\s*supersede/);
  });

  it("offers a confirm button that re-submits with force", () => {
    expect(src).toMatch(/Add anyway/);
    expect(src).toMatch(/onClick=\{\(\) => save\(true\)\}/);
  });

  it("offers a way out that keeps the vendor date", () => {
    expect(src).toMatch(/Keep the vendor date/);
  });

  it("keeps the existing success path intact", () => {
    expect(src).toContain("setOutOfWeekNote(outOfWeekSaveNote(date, weekOf))");
    expect(src).toContain('setSymbol("")');
    expect(src).toContain("setOpen(false)");
    expect(src).toContain('new Event("earnings-data-changed")');
    expect(src).toContain("router.refresh()");
  });

  it("has no empty catch block (honest failure reporting)", () => {
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
});
