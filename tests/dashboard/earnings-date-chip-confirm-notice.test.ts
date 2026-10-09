import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// No DOM harness: source-scan pins. The Hub chip's confirm handler must read
// the route through readMutationResult and show the route's `notice` as a
// visible message (not a browser alert), like the calendar conflict marker.
const src = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");
const start = src.indexOf("async function confirm(date: string");
const body = src.slice(start, src.indexOf("return (", start));

describe("Hub date chip confirm handler", () => {
  it("reads the response through readMutationResult and networkFailureMessage", () => {
    expect(src).toMatch(/import\s*\{[^}]*readMutationResult[^}]*\}\s*from "@\/lib\/ui\/mutation-result"/);
    expect(body).toContain("readMutationResult");
    expect(body).toContain("networkFailureMessage");
  });

  it("surfaces data.notice in a visible status line, not an alert", () => {
    expect(body).toContain("notice");
    expect(body).toContain("setConfirmNotice(");
    expect(body).not.toContain("alert(");
    expect(src).toContain('role="status"');
    expect(src).toMatch(/\{confirmNotice &&/);
  });

  it("keeps the popover open while a notice is showing", () => {
    const noticeIdx = body.indexOf("setConfirmNotice(");
    const closeIdx = body.indexOf("setOpen(false)");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeGreaterThan(noticeIdx);
  });
});
