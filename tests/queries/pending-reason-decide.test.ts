/**
 * decidePendingReason — the pure per-side rule of the pending read model
 * (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 3; rulings R2, R11, R17). Every expected state below is written by
 * hand, never derived from the function under test.
 */
import { describe, it, expect } from "vitest";
import {
  decidePendingReason,
  type HoldingEvidence,
  type PendingDecisionInput,
} from "@/lib/queries/pending-statement";
import type { PendingSide } from "@/lib/queries/pending-statement-types";

const STMT = "2026-06-30";
const LIVE = "2026-07-10";

function input(over: Partial<PendingDecisionInput>): PendingDecisionInput {
  return {
    cls: "new",
    side: "long",
    isOption: true,
    newest: { date: LIVE, quantity: 0, evidence: "live" },
    statement: null,
    resymbolReplacementHeld: false,
    longEquityGuards: { laterFill: false, laterSplit: false },
    reopenedAfter: () => false,
    ...over,
  };
}

/** A reopening dated `on`: "after d" is strictly d < on (R17). */
const reopenOn = (on: string) => (d: string) => d < on;

describe("T-ONE-STATE: one reason or none, hand table over class x evidence x reopen", () => {
  type Row = [
    name: string,
    over: Partial<PendingDecisionInput>,
    expected: { reason: string; flatDate: string } | null,
  ];
  const n = (date: string, quantity: number, evidence: HoldingEvidence) => ({ date, quantity, evidence });
  const table: Row[] = [
    // new class, long side
    ["new long: live zero, no statement", {}, { reason: "awaiting_statement", flatDate: LIVE }],
    ["new long: live zero, reopened after it", { reopenedAfter: reopenOn("2026-07-11") }, null],
    ["new long: live short row (flipped)", { newest: n(LIVE, -5, "live") }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["new long: live positive row (E3)", { newest: n(LIVE, 5, "live") }, null],
    ["new long: statement zero newest", { newest: n(STMT, 0, "statement"), statement: { date: STMT, quantity: 0 } }, { reason: "closing_entry_missing", flatDate: STMT }],
    ["new long: statement zero newest, reopened after it", { newest: n(STMT, 0, "statement"), statement: { date: STMT, quantity: 0 }, reopenedAfter: reopenOn("2026-07-01") }, null],
    ["new long: statement opposite-sign row (OPEN-8)", { newest: n(STMT, -5, "statement"), statement: { date: STMT, quantity: -5 } }, null],
    ["new long: statement positive row", { newest: n(STMT, 5, "statement"), statement: { date: STMT, quantity: 5 } }, null],
    ["new long: other-origin zero", { newest: n(LIVE, 0, "other") }, null],
    ["new long: live zero over a non-zero statement", { statement: { date: STMT, quantity: 5 } }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["new long: no holdings row at all", { newest: null }, null],
    // new class, short side
    ["new short: live zero", { side: "short" }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["new short: live long row (flipped)", { side: "short", newest: n(LIVE, 5, "live") }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["new short: live negative row (E3)", { side: "short", newest: n(LIVE, -5, "live") }, null],
    ["new short: statement zero", { side: "short", isOption: false, newest: n(STMT, 0, "statement"), statement: { date: STMT, quantity: 0 } }, { reason: "closing_entry_missing", flatDate: STMT }],
    ["new short: statement positive row (OPEN-8)", { side: "short", isOption: false, newest: n(STMT, 5, "statement"), statement: { date: STMT, quantity: 5 } }, null],
    // re-symbol
    ["option, replacement held, live zero", { resymbolReplacementHeld: true }, { reason: "resymbol_repair_pending", flatDate: LIVE }],
    ["option, replacement held, statement zero then live zero", { resymbolReplacementHeld: true, statement: { date: STMT, quantity: 0 } }, { reason: "resymbol_repair_pending", flatDate: LIVE }],
    ["option, replacement held, newest row not flat", { resymbolReplacementHeld: true, newest: n(LIVE, 5, "live") }, null],
    ["option, replacement held, even after a reopening", { resymbolReplacementHeld: true, reopenedAfter: () => true }, { reason: "resymbol_repair_pending", flatDate: LIVE }],
    ["short stock never takes the re-symbol reason", { side: "short", isOption: false, resymbolReplacementHeld: true }, { reason: "awaiting_statement", flatDate: LIVE }],
    // long equity (unchanged rule)
    ["long_equity: live zero", { cls: "long_equity", isOption: false }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["long_equity: live short row (PR #123)", { cls: "long_equity", isOption: false, newest: n(LIVE, -30, "live") }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["long_equity: newest statement-grade zero over an older live zero", { cls: "long_equity", isOption: false, newest: n(LIVE, 0, "live"), statement: { date: STMT, quantity: 0 } }, null],
    ["long_equity: statement zero newest", { cls: "long_equity", isOption: false, newest: n(STMT, 0, "statement"), statement: { date: STMT, quantity: 0 } }, null],
    ["long_equity: later fill guard", { cls: "long_equity", isOption: false, longEquityGuards: { laterFill: true, laterSplit: false } }, null],
    ["long_equity: later split guard", { cls: "long_equity", isOption: false, longEquityGuards: { laterFill: false, laterSplit: true } }, null],
    ["long_equity: a reopening is NOT its rule (guards are)", { cls: "long_equity", isOption: false, reopenedAfter: () => true }, { reason: "awaiting_statement", flatDate: LIVE }],
    ["long_equity: other-origin zero", { cls: "long_equity", isOption: false, newest: n(LIVE, 0, "other") }, null],
    // no class
    ["no class (bond, fund, cash)", { cls: null }, null],
  ];

  it.each(table)("%s", (_name, over, expected) => {
    expect(decidePendingReason(input(over))).toEqual(expected);
  });

  it("over the whole grid the answer is null or exactly one reason with a flat date from the evidence", () => {
    const sides: PendingSide[] = ["long", "short"];
    const evidences: HoldingEvidence[] = ["statement", "live", "other"];
    for (const cls of ["long_equity", "new", null] as const)
      for (const side of sides)
        for (const evidence of evidences)
          for (const quantity of [-5, 0, 5])
            for (const stmtQty of [null, 0, 5])
              for (const reopen of [false, true])
                for (const held of [false, true]) {
                  const d = decidePendingReason(
                    input({
                      cls,
                      side,
                      newest: { date: LIVE, quantity, evidence },
                      statement: stmtQty == null ? null : { date: STMT, quantity: stmtQty },
                      reopenedAfter: () => reopen,
                      resymbolReplacementHeld: held,
                    })
                  );
                  if (d == null) continue;
                  expect(["awaiting_statement", "closing_entry_missing", "resymbol_repair_pending"]).toContain(d.reason);
                  expect([STMT, LIVE]).toContain(d.flatDate);
                  expect(cls).not.toBeNull();
                  expect(evidence).not.toBe("other");
                }
  });
});

describe("T-FLATDATE", () => {
  it("statement-zero-only: closing_entry_missing at the statement date", () => {
    expect(
      decidePendingReason(
        input({ newest: { date: STMT, quantity: 0, evidence: "statement" }, statement: { date: STMT, quantity: 0 } })
      )
    ).toEqual({ reason: "closing_entry_missing", flatDate: STMT });
  });

  it("statement-zero-then-newer-live-zero: closing_entry_missing at the STATEMENT date", () => {
    expect(decidePendingReason(input({ statement: { date: STMT, quantity: 0 } }))).toEqual({
      reason: "closing_entry_missing",
      flatDate: STMT,
    });
  });

  it("same-side-reopening-between-statement-and-live-zero: awaiting_statement at the live date", () => {
    expect(
      decidePendingReason(input({ statement: { date: STMT, quantity: 0 }, reopenedAfter: reopenOn("2026-07-05") }))
    ).toEqual({ reason: "awaiting_statement", flatDate: LIVE });
  });

  it("a reopening dated ON the flat date is not later (R17)", () => {
    expect(
      decidePendingReason(input({ statement: { date: STMT, quantity: 0 }, reopenedAfter: reopenOn(STMT) }))
    ).toEqual({ reason: "closing_entry_missing", flatDate: STMT });
    expect(decidePendingReason(input({ reopenedAfter: reopenOn(LIVE) }))).toEqual({
      reason: "awaiting_statement",
      flatDate: LIVE,
    });
  });
});
