import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { runLevelScanCycle } from "@/lib/alerts/scan-cycle";

/**
 * runLevelScanCycle — the shared level-scan sequence (reconcile cloud-fired →
 * detect → post mac-recent-scan marker → suggestions) used by auto-refresh
 * Step 6 AND the IBKR Web API disconnected refresh (R1b). DI-injected deps so
 * no network/Claude is touched.
 */

const db = new Database(":memory:");

function makeDeps(overrides: Partial<Parameters<typeof runLevelScanCycle>[2]> = {}) {
  return {
    reconcile: vi.fn(async () => ({
      ok: true,
      reconciled: 2,
      skipped_already_alerted: 0,
      skipped_level_missing: 0,
    })),
    detect: vi.fn(() => ({ scanned: 5, fired: 1, deduped: 0 })),
    postMarker: vi.fn(async () => {}),
    suggest: vi.fn(async () => ({ generated: 1, failed: 0 })),
    ...overrides,
  };
}

describe("runLevelScanCycle", () => {
  it("without a cron secret: detects + suggests, but skips reconcile and marker", async () => {
    const deps = makeDeps();
    const res = await runLevelScanCycle(db, {}, deps);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.postMarker).not.toHaveBeenCalled();
    expect(deps.detect).toHaveBeenCalledOnce();
    expect(deps.suggest).toHaveBeenCalledOnce();
    expect(res).toEqual({ reconciled: 0, scanned: 5, fired: 1, deduped: 0, suggestionsGenerated: 1 });
  });

  it("with a cron secret: reconciles cloud-fired levels BEFORE detect, then posts the marker", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      reconcile: vi.fn(async () => {
        order.push("reconcile");
        return { ok: true, reconciled: 2, skipped_already_alerted: 0, skipped_level_missing: 0 };
      }),
      detect: vi.fn(() => {
        order.push("detect");
        return { scanned: 5, fired: 1, deduped: 0 };
      }),
      postMarker: vi.fn(async () => {
        order.push("marker");
      }),
    });
    const res = await runLevelScanCycle(db, { cronSecret: "s3cret" }, deps);
    expect(order.slice(0, 2)).toEqual(["reconcile", "detect"]);
    expect(order).toContain("marker");
    expect(res.reconciled).toBe(2);
  });

  it("a reconcile failure never blocks detection", async () => {
    const deps = makeDeps({
      reconcile: vi.fn(async () => {
        throw new Error("worker unreachable");
      }),
    });
    const res = await runLevelScanCycle(db, { cronSecret: "s" }, deps);
    expect(deps.detect).toHaveBeenCalledOnce();
    expect(res.reconciled).toBe(0);
    expect(res.fired).toBe(1);
  });

  it("skips suggestion generation when nothing fired, and tolerates its failure when it runs", async () => {
    const quiet = makeDeps({ detect: vi.fn(() => ({ scanned: 3, fired: 0, deduped: 1 })) });
    const quietRes = await runLevelScanCycle(db, {}, quiet);
    expect(quiet.suggest).not.toHaveBeenCalled();
    expect(quietRes.suggestionsGenerated).toBe(0);

    const failing = makeDeps({
      suggest: vi.fn(async () => {
        throw new Error("claude down");
      }),
    });
    const res = await runLevelScanCycle(db, {}, failing);
    expect(res.fired).toBe(1);
    expect(res.suggestionsGenerated).toBe(0);
  });
});
