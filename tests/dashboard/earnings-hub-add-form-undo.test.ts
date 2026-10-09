import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { undoManualEarningsAdd } from "@/app/dashboard/today/EarningsHubAddForm";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// F1 2026-10-08 (qa: add-ticker other-week saves silently): after a save into
// another week the notice offers an Undo that deletes the row just created.

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("undoManualEarningsAdd", () => {
  it("DELETEs the row just created through the manual-event route", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const out = await undoManualEarningsAdd(41, async (url, init) => {
      seen = { url: String(url), init };
      return reply(200, { success: true });
    });
    expect(out).toEqual({ ok: true });
    expect(seen!.url).toBe("/api/calendar/events");
    expect(seen!.init?.method).toBe("DELETE");
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ id: 41 });
  });

  it("reports the server's own words when the delete is refused", async () => {
    const out = await undoManualEarningsAdd(41, async () => reply(404, { error: "Event not found." }));
    expect(out).toEqual({ ok: false, message: "Event not found." });
  });

  it("a 200 without success:true is a failure, not an undo", async () => {
    const out = await undoManualEarningsAdd(41, async () => reply(200, { success: false }));
    expect(out.ok).toBe(false);
  });

  it("explains an unreachable server in plain words", async () => {
    const out = await undoManualEarningsAdd(41, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(out).toEqual({
      ok: false,
      message: "Couldn't undo that entry: could not reach the server. Try again.",
    });
  });
});

describe("the Undo is wired beside the other-week notice", () => {
  const form = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");

  it("remembers the saved id only for an out-of-week save", () => {
    expect(form).toContain("setUndoId(outOfWeekSaveNote(date, weekOf) !== null ? outcome.id : null)");
    expect(form).toContain("undoManualEarningsAdd(undoId)");
  });

  it("renders an always-visible, tappable Undo button after the link", () => {
    const link = anchorIndex(form, "{outOfWeekLink.label}");
    const btn = anchorIndex(form, "Undo", link);
    const tag = form.slice(anchorIndex(form, "<button", link), btn);
    expect(tag).toContain("onClick={undo}");
    expect(tag).not.toMatch(/opacity-0|group-hover|\bhidden\b/);
    expect(tag).toContain("pointer-coarse:after:-inset-y-3");
  });

  it("refreshes the page and tells the hub after a successful undo", () => {
    const fn = form.slice(anchorIndex(form, "async function undo()"));
    expect(fn.slice(0, 900)).toContain('window.dispatchEvent(new Event("earnings-data-changed"))');
    expect(fn.slice(0, 900)).toContain("router.refresh()");
  });
});
