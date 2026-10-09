/**
 * The hub's remove control on a row that "Fix date" minted
 * (qa:today-earningshub-fix-date--suppression-row-delete-loses-coverage-permanently,
 * owner ruling 2026-09-02 option 2).
 *
 * No DOM harness: the request and the copy are pure helpers; the wiring is
 * pinned against source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  deleteEarningsEvent,
  fixDatedDeleteCopy,
} from "@/app/dashboard/today/EarningsDeleteButton";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

function recordingFetch(status: number, body: unknown) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: (init?.method ?? "GET").toString(),
      body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("deleteEarningsEvent", () => {
  it("a plain remove sends only the id", async () => {
    const { calls, fetchImpl } = recordingFetch(200, { success: true });
    const outcome = await deleteEarningsEvent({ eventId: 7 }, fetchImpl);
    expect(calls).toEqual([{ method: "DELETE", body: { id: 7 } }]);
    expect(outcome).toEqual({ kind: "removed", suppressionsLifted: null });
  });

  it("remove-and-restore sends restoreVendorDate and reports what was lifted", async () => {
    const { calls, fetchImpl } = recordingFetch(200, {
      success: true,
      vendorDate: "2026-09-03",
      suppressionsLifted: 1,
    });
    const outcome = await deleteEarningsEvent({ eventId: 7, restoreVendorDate: true }, fetchImpl);
    expect(calls[0].body).toEqual({ id: 7, restoreVendorDate: true });
    expect(outcome).toEqual({ kind: "removed", suppressionsLifted: 1 });
  });

  it("a 2xx without success is a failure; a refusal carries the server's words", async () => {
    const soft = recordingFetch(200, { success: false });
    expect((await deleteEarningsEvent({ eventId: 7 }, soft.fetchImpl)).kind).toBe("failed");

    const refused = recordingFetch(400, { success: false, error: "Nothing was removed." });
    expect(await deleteEarningsEvent({ eventId: 7, restoreVendorDate: true }, refused.fetchImpl)).toEqual({
      kind: "failed",
      message: "Nothing was removed.",
    });
  });

  it("a fetch that throws is reported as unreachable, never swallowed", async () => {
    const outcome = await deleteEarningsEvent({ eventId: 7 }, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(outcome).toEqual({ kind: "unreachable" });
  });
});

describe("fixDatedDeleteCopy", () => {
  it("names the hidden vendor date and what a plain remove costs", () => {
    const copy = fixDatedDeleteCopy("ZZA", "2026-09-03");
    expect(copy.title).toContain("ZZA");
    expect(copy.message).toContain("2026-09-03");
    expect(copy.message).toContain("no earnings date");
    expect(copy.restoreLabel).toBe("Remove and restore vendor date");
    expect(copy.removeOnlyLabel).toBe("Remove only");
  });
});

describe("wiring", () => {
  const BUTTON = readFileSync("app/dashboard/today/EarningsDeleteButton.tsx", "utf8");
  const HUB = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");

  it("a fix-dated row asks in its three-answer dialog instead of the two-answer question", () => {
    const click = sliceBetween(BUTTON, "function handleClick()", "const copy =");
    const dialog = anchorIndex(click, "setAsking(true);");
    // The two-answer question moved from the browser's confirm() to the app
    // dialog (2026-10-08); the fix-dated branch still returns ahead of it.
    const twoAnswer = anchorIndex(click, "await prompt.ask(");
    expect(dialog).toBeLessThan(twoAnswer);
    expect(click).not.toMatch(/(?<![.\w])confirm\(/);
    expect(BUTTON).toContain("onClick={() => void remove(true)}");
    expect(BUTTON).toContain("onClick={() => void remove(false)}");
    // <dialog> needs m-auto under Tailwind v4's preflight.
    expect(sliceBetween(BUTTON, "<dialog", "onCancel")).toContain("m-auto");
  });

  it("both hub layouts tell the button which vendor date the row was corrected from", () => {
    const needle = "vendorDate={fixDateOrigin(event)}";
    const first = anchorIndex(HUB, needle);
    anchorIndex(HUB, needle, first + needle.length, "mobile card");
  });
});
