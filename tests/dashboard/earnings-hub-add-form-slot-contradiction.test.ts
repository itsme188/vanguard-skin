/**
 * "+ Add ticker" — slot picker labels and the slot-contradiction confirm
 * (user ruling 2026-10-05).
 *
 * (a) The picker reads just "BMO" / "AMC": the old "AMC (16:15)" label
 *     promised a clock time the server did not store (it stored 16:05).
 * (b) A 409 `slot_contradicts_known_time` is surfaced inline in the server's
 *     own words with an explicit "Add anyway" second click that re-sends the
 *     identical add with `force: true` — never a browser confirm dialog.
 *
 * No DOM harness in this repo: the network half is the extracted
 * `postManualEarningsEvent`, the JSX half is a source pin.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { postManualEarningsEvent } from "@/app/dashboard/today/EarningsHubAddForm";

const SOURCE = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");
const ADD = { symbol: "ZQTEST", date: "2026-10-12", slot: "BMO" as const };

const REFUSAL_BODY = {
  success: false,
  error:
    "ZQTEST usually reports at 4:05 PM ET, after the close — but you picked BMO (before the open).",
  code: "slot_contradicts_known_time",
  slot: "BMO",
  knownTime: "16:05",
  slotDefaultTime: "08:00",
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

describe("slot picker labels", () => {
  it("carry no clock time", () => {
    const options = [...SOURCE.matchAll(/<option value="(BMO|AMC)">([^<]*)<\/option>/g)];
    expect(options.map((m) => m[1])).toEqual(["BMO", "AMC"]);
    for (const m of options) {
      expect(m[2]).toBe(m[1]);
      expect(m[2]).not.toMatch(/\d/);
    }
    expect(SOURCE).not.toMatch(/AMC \(\d/);
    expect(SOURCE).not.toMatch(/BMO \(\d/);
  });
});

describe("postManualEarningsEvent — the 409 slot_contradicts_known_time path", () => {
  it("surfaces the refusal in the server's words instead of a generic failure", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 409, body: REFUSAL_BODY }]);
    const outcome = await postManualEarningsEvent(ADD, fetchImpl);
    expect(outcome).toEqual({
      kind: "slot_refused",
      refusal: { message: REFUSAL_BODY.error, knownTime: "16:05", slotDefaultTime: "08:00" },
    });
    expect(calls[0].body.force).toBeUndefined();
  });

  it("the confirm click re-sends the identical add with forceSlot only — never force", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { success: true, id: 7 } }]);
    const outcome = await postManualEarningsEvent({ ...ADD, forceSlot: true }, fetchImpl);
    expect(outcome).toEqual({ kind: "saved", id: 7 });
    expect(calls[0].body).toMatchObject({
      symbol: "ZQTEST",
      event_date: "2026-10-12",
      event_time: "BMO",
      forceSlot: true,
    });
    expect(calls[0].body.force).toBeUndefined();
  });

  it("a vendor-supersede confirm sends force only — never forceSlot", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { success: true, id: 8 } }]);
    await postManualEarningsEvent({ ...ADD, force: true }, fetchImpl);
    expect(calls[0].body.force).toBe(true);
    expect(calls[0].body.forceSlot).toBeUndefined();
  });

  it("both acknowledgements travel together once both warnings were answered", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { success: true, id: 9 } }]);
    await postManualEarningsEvent({ ...ADD, force: true, forceSlot: true }, fetchImpl);
    expect(calls[0].body).toMatchObject({ force: true, forceSlot: true });
  });

  it("a 409 without the code is still a plain failure", async () => {
    const { fetchImpl } = recordingFetch([{ status: 409, body: { error: "Already exists." } }]);
    expect(await postManualEarningsEvent(ADD, fetchImpl)).toEqual({
      kind: "failed",
      message: "Already exists.",
    });
  });
});

describe("EarningsHubAddForm wiring (source pin)", () => {
  it("renders the refusal inline; its Add anyway sends forceSlot, the vendor one sends force", () => {
    expect(SOURCE).toMatch(/slotRefusal\.message/);
    expect(SOURCE).toMatch(/Add anyway as \$\{slot\}/);
    expect(SOURCE).toMatch(/onClick=\{\(\) => save\(\{ \.\.\.acks, forceSlot: true \}\)\}/);
    expect(SOURCE).toMatch(/onClick=\{\(\) => save\(\{ \.\.\.acks, force: true \}\)\}/);
    // No button may answer both warnings at once.
    expect(SOURCE).not.toMatch(/save\(true\)/);
    expect(SOURCE).not.toMatch(/force: true, forceSlot: true/);
  });

  it("an acknowledgement is remembered across the resend, and a plain Add carries none", () => {
    expect(SOURCE).toMatch(/setAcks\(nextAcks\)/);
    expect(SOURCE).toMatch(/await save\(NO_ACKS\)/);
  });

  it("changing the ticker, the date or the slot clears BOTH refusals and both acks", () => {
    const reset = SOURCE.match(/function resetGuards\(\) \{([\s\S]*?)\n  \}/);
    expect(reset).not.toBeNull();
    expect(reset![1]).toContain("setSupersede(null)");
    expect(reset![1]).toContain("setSlotRefusal(null)");
    expect(reset![1]).toContain("setAcks(NO_ACKS)");
    for (const setter of ["setSymbol(e.target.value.toUpperCase())", "setDate(e.target.value)", "setSlot(e.target.value as Slot)"]) {
      const i = SOURCE.indexOf(setter);
      expect(i).toBeGreaterThan(-1);
      expect(SOURCE.slice(i, i + 120)).toContain("resetGuards()");
    }
  });

  it("never uses a browser confirm dialog", () => {
    expect(SOURCE).not.toMatch(/window\.confirm\(|[^.\w]confirm\(/);
  });
});
