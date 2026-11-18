/**
 * Bogey intake 2026-11-18, Task D: the "not read" list mounts on BOTH Hub
 * layouts (desktop row and mobile card), right after the live print slot, and
 * only for an armed row. Source-pin (no DOM harness in this repo); the
 * component's own contract (no AI on load, the shared mutation reader, no
 * native dialogs) is pinned on its source too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const root = process.cwd();
const hub = readFileSync(join(root, "app/dashboard/today/EarningsHub.tsx"), "utf8");
const component = readFileSync(join(root, "app/dashboard/today/UnreadPreviews.tsx"), "utf8");

const MOUNT = "{e.worksheetArmed && <UnreadPreviews eventId={e.id} />}";

describe("UnreadPreviews mount on the Earnings Hub", () => {
  it("is imported once", () => {
    expect(hub).toMatch(/import UnreadPreviews from "\.\/UnreadPreviews";/);
  });

  it("mounts on the desktop row and the mobile card, armed rows only, after the live print slot", () => {
    const desktop = anchorIndex(hub, "<DesktopRow event={e} />", 0, "desktop row");
    const desktopSlot = anchorIndex(hub, "<LivePrintSlot", desktop, "desktop slot");
    const desktopMount = anchorIndex(hub, MOUNT, desktopSlot, "desktop mount");
    const mobile = anchorIndex(hub, "<MobileCard event={e} />", 0, "mobile card");
    expect(desktopMount).toBeLessThan(mobile);
    const mobileSlot = anchorIndex(hub, "<LivePrintSlot", mobile, "mobile slot");
    anchorIndex(hub, MOUNT, mobileSlot, "mobile mount");
    expect(hub.split("<UnreadPreviews ").length - 1).toBe(2);
    // Never mounted without the armed gate.
    expect(hub.split(MOUNT).length - 1).toBe(2);
  });
});

describe("UnreadPreviews component contract", () => {
  it("is a client component that reads the unread list and posts the read through apiFetch", () => {
    expect(component.startsWith('"use client";')).toBe(true);
    expect(component).toContain("/api/earnings/bogeys/unread?eventId=");
    expect(component).toContain('"/api/earnings/bogeys/read-article"');
    expect(component).toMatch(/import apiFetch from "@\/lib\/http\/apiFetch";/);
    expect(component).toContain("readMutationResult");
    expect(component).toContain("networkFailureMessage");
    expect(component).toContain("router.refresh()");
  });

  it("calls the read route only from the button handler, never on load", () => {
    const effect = anchorIndex(component, "useEffect(", 0, "load effect");
    const effectEnd = anchorIndex(component, "}, [", effect, "effect deps");
    expect(component.slice(effect, effectEnd)).not.toContain("read-article");
  });

  it("uses no native dialogs and no bare res.ok gate", () => {
    expect(component).not.toMatch(/\b(?:window\.)?(?:alert|confirm|prompt)\(/);
    expect(component).not.toMatch(/res\.ok/);
  });
});
