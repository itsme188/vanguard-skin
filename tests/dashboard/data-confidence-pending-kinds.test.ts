/**
 * Data-confidence popover and Data Health page: one label per integrity hit
 * kind (plan 2026-10-26 Task 11, R16). Source pins: this repo has no DOM
 * harness. The first four pins moved here from tax-lots-pending-statement.test.tsx.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  PENDING_INTEGRITY_CHIP_LABEL,
  PENDING_INTEGRITY_SUFFIX,
} from "@/app/dashboard/components/pending-statement-copy";

const src = readFileSync("app/dashboard/components/DataConfidenceIndicator.tsx", "utf8");
const page = readFileSync("app/dashboard/data-health/page.tsx", "utf8");
const warningsFn = src.match(/^function IntegrityWarningsRow\([\s\S]*?\n\}/m)?.[0] ?? "";
const criticalFn = src.match(/^function IntegrityCriticalRow\([\s\S]*?\n\}/m)?.[0] ?? "";

const NEW_KINDS = [
  "closing-entry-missing",
  "resymbol-repair-pending",
  "closing-entry-account-undecidable",
  "exercise-price-missing",
  "exercise-leg-missing",
] as const;

describe("Data-confidence popover (source pin)", () => {
  it("isolates the warnings row", () => {
    expect(warningsFn).not.toBe("");
  });

  it("labels a statement-lag hit 'awaiting statement' with the shared chip", () => {
    expect(warningsFn).toMatch(
      /\{w\.kind === "statement-lag" && \([\s\S]{0,80}<Chip tone="neutral" size="xs" title=\{PENDING_STATEMENT_TITLE\}>\s*\{STATEMENT_LAG_LABEL\}\s*<\/Chip>/
    );
  });

  it("keeps the reason inside <PrivateText>", () => {
    expect(warningsFn).toMatch(/<PrivateText>\{w\.reason\}<\/PrivateText>/);
  });

  it("statement-lag stays in the warnings (informational) row, never in the critical row", () => {
    expect(criticalFn).not.toBe("");
    expect(criticalFn).not.toContain("statement-lag");
  });

  it("every new warning kind gets a chip from the shared label table, with a title", () => {
    expect(warningsFn).toContain("PENDING_INTEGRITY_CHIP_LABEL[w.kind as PendingIntegrityKind]");
    expect(warningsFn).toContain("PENDING_INTEGRITY_SUFFIX[w.kind as PendingIntegrityKind]");
    expect(warningsFn).toMatch(/<Chip tone="neutral" size="xs" title=\{PENDING_INTEGRITY_SUFFIX/);
    for (const k of NEW_KINDS) {
      expect(PENDING_INTEGRITY_CHIP_LABEL[k]).toBeTruthy();
      expect(PENDING_INTEGRITY_SUFFIX[k]).toBeTruthy();
    }
  });

  it("hand-writes no tint pair and no label text for the new kinds", () => {
    expect(warningsFn).not.toMatch(/bg-(up|down|gold|warn)\/\d+/);
    for (const k of NEW_KINDS) expect(warningsFn).not.toContain(PENDING_INTEGRITY_CHIP_LABEL[k]);
  });

  it("the critical account-mismatch hit shows through the critical row's reason, masked", () => {
    expect(criticalFn).toContain("<PrivateText>{c.reason}</PrivateText>");
    expect(PENDING_INTEGRITY_CHIP_LABEL["closing-entry-account-mismatch"]).toBeTruthy();
  });
});

describe("Data Health page (source pin)", () => {
  it("adds the plain suffix for each new kind from the copy module", () => {
    expect(page).toContain("PENDING_INTEGRITY_SUFFIX[hit.kind as PendingIntegrityKind]");
    expect(page).toContain("hit.kind in PENDING_INTEGRITY_SUFFIX");
  });

  it("keeps the hit reason masked and the statement-lag suffix", () => {
    expect(page).toContain("<PrivateText>{hit.reason}</PrivateText>");
    expect(page).toContain("expected — clears with the next statement");
  });

  it("imports copy only from the plain module, never from a client component file", () => {
    expect(page).toContain('from "../components/pending-statement-copy"');
    expect(page).not.toContain("DataConfidenceIndicator");
    expect(readFileSync("app/dashboard/components/pending-statement-copy.ts", "utf8")).not.toContain('"use client"');
  });
});
