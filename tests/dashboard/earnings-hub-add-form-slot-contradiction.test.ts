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

  it("the confirm click re-sends the identical add with force: true", async () => {
    const { calls, fetchImpl } = recordingFetch([{ status: 200, body: { success: true, id: 7 } }]);
    const outcome = await postManualEarningsEvent({ ...ADD, force: true }, fetchImpl);
    expect(outcome).toEqual({ kind: "saved", id: 7 });
    expect(calls[0].body).toMatchObject({
      symbol: "ZQTEST",
      event_date: "2026-10-12",
      event_time: "BMO",
      force: true,
    });
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
  it("renders the refusal inline with an explicit Add anyway button that forces", () => {
    expect(SOURCE).toMatch(/slotRefusal\.message/);
    expect(SOURCE).toMatch(/Add anyway/);
    expect(SOURCE).toMatch(/onClick=\{\(\) => save\(true\)\}/);
  });

  it("never uses a browser confirm dialog", () => {
    expect(SOURCE).not.toMatch(/window\.confirm\(|[^.\w]confirm\(/);
  });
});
