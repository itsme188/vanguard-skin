/**
 * "+ Add ticker" asks before adding a second print beside a confirmed vendor
 * date in the same week
 * (qa:dashboard-today-earningshub-add-ticker-hand-entered-date-beside-a-vendor-date-in-the-same-week-hand-entered-da;
 * owner ruling 2026-10-12, option 1).
 *
 * The POST answers 409 `would_contradict_confirmed_date`; the form shows the
 * server's sentence inline, the same way it asks the two other server
 * warnings, and the confirm button resends the SAME add with
 * `forceContradictConfirmed: true`, carrying any acknowledgement already
 * given. No DOM harness in this repo: the network half is covered through the
 * injectable helper, the JSX wiring by a source scan.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { postManualEarningsEvent } from "@/app/dashboard/today/EarningsHubAddForm";

const ADD = { symbol: "AAA", date: "2025-03-14", slot: "AMC" as const };

const REFUSAL_BODY = {
  success: false,
  error:
    "Finnhub has AAA earnings confirmed for 2025-03-13 (two sources agree). Nothing was added. Your 2025-03-14 entry would show as a second print the same week, with its own preview and recap emails. Change the date, or add anyway to keep both.",
  code: "would_contradict_confirmed_date",
  vendorEventId: 12,
  vendorDate: "2025-03-13",
  vendorSource: "finnhub",
};

function recordingFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    calls.push({ body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown> });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("postManualEarningsEvent — the 409 would_contradict_confirmed_date path", () => {
  it("surfaces the refusal with the server's sentence and the vendor date", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: REFUSAL_BODY }]);

    const outcome = await postManualEarningsEvent(ADD, fetchImpl);

    expect(outcome.kind).toBe("confirmed_refused");
    if (outcome.kind !== "confirmed_refused") throw new Error("unreachable");
    expect(outcome.refusal.message).toBe(REFUSAL_BODY.error);
    expect(outcome.refusal.vendorDate).toBe("2025-03-13");
    expect(outcome.refusal.vendorSource).toBe("finnhub");
    expect(calls[0].body.forceContradictConfirmed).toBeUndefined();
    expect(calls[0].body.force).toBeUndefined();
  });

  it("resends the identical add with forceContradictConfirmed only", async () => {
    const { calls, fetchImpl } = recordingFetch([
      { status: 409, body: REFUSAL_BODY },
      { status: 200, body: { success: true, id: 7 } },
    ]);

    await postManualEarningsEvent(ADD, fetchImpl);
    const confirmed = await postManualEarningsEvent(
      { ...ADD, forceContradictConfirmed: true },
      fetchImpl,
    );

    expect(confirmed).toEqual({ kind: "saved", id: 7 });
    expect(calls[1].body.forceContradictConfirmed).toBe(true);
    expect(calls[1].body.force).toBeUndefined();
    expect(calls[1].body.forceSlot).toBeUndefined();
    expect(calls[1].body.symbol).toBe(calls[0].body.symbol);
    expect(calls[1].body.event_date).toBe(calls[0].body.event_date);
    expect(calls[1].body.event_time).toBe(calls[0].body.event_time);
  });
});

describe("EarningsHubAddForm — confirmed-date question wiring (static scan)", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");

  it("handles the refusal code in its own state", () => {
    expect(src).toContain('data?.code === "would_contradict_confirmed_date"');
    expect(src).toMatch(/outcome\.kind === "confirmed_refused"/);
    expect(src).toMatch(/setConfirmedRefusal\(outcome\.refusal\)/);
  });

  it("renders the server's sentence and resends with forceContradictConfirmed, carrying other acks", () => {
    expect(src).toContain("{confirmedRefusal.message}");
    expect(src).toMatch(
      /onClick=\{\(\) => save\(\{ \.\.\.acks, forceContradictConfirmed: true \}\)\}/,
    );
  });

  it("clears the question when the ticker, date or slot changes", () => {
    const reset = src.slice(src.indexOf("function resetGuards()"));
    expect(reset.slice(0, reset.indexOf("}"))).toContain("setConfirmedRefusal(null)");
  });

  it("asks in the app, never through a native browser dialog", () => {
    expect(src).not.toMatch(/\bwindow\.confirm\(|\bconfirm\(|\balert\(/);
  });
});
