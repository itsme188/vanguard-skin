/**
 * The Giving screens' disclose-and-confirm flow (owner ruling 2026-10-06).
 *
 * Three layers, none of them a stand-in for the code under test:
 *  1. `LedgerFlowController` driven against the REAL donation route on an
 *     in-memory database — refusal, confirm, run, result, double click,
 *     cancel, dropped connection, a recompute that fails;
 *  2. the dialog body rendered to static markup — the words, and the counts
 *     going through the privacy components;
 *  3. source pins — every Giving mutation is sent through the flow.
 *
 * There is no DOM harness in this repo, so a click is a direct call on the
 * controller the hook wraps.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { linkDonationLegs } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getLedgerCensus } from "@/lib/compute/donation-recompute";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let mockPrivate = false;
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: mockPrivate, setPrivate: () => {}, toggle: () => {} }),
}));

import {
  LedgerFlowController,
  isLedgerFlowBusy,
  withLedgerAck,
  type LedgerFlowPhase,
} from "@/app/dashboard/components/giving/ledger-recompute-flow";
import { LedgerRecomputeBody } from "@/app/dashboard/components/giving/LedgerRecomputeDialog";

beforeEach(() => {
  mockPrivate = false;
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

let seq = 0;
function txn(sec: number, date: string, type: string, qty: number, price: number): number {
  seq++;
  return hoisted.db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(sec, date, type, qty, price, qty * price, `flow-${seq}`).lastInsertRowid as number;
}

function seedBook() {
  const db = hoisted.db;
  const sec = db.prepare("INSERT INTO securities (symbol, currency) VALUES ('ZZAA', 'USD')").run()
    .lastInsertRowid as number;
  const other = db.prepare("INSERT INTO securities (symbol, currency) VALUES ('ZZBB', 'USD')").run()
    .lastInsertRowid as number;
  const buyId = txn(sec, "2026-01-05", "BUY", 100, 10);
  txn(other, "2026-01-06", "BUY", 50, 20);
  txn(other, "2026-02-06", "SELL", 20, 30);
  const out = txn(sec, "2026-03-02", "TRANSFER_OUT", 40, 0);
  const donationId = insertDonation(
    db,
    {
      sourceKey: `flow-don-${++seq}`,
      kind: "stock",
      securityId: sec,
      symbolRaw: "ZZAA",
      quantity: 40,
      fmvUsd: 2000,
      unitValuation: null,
      createdDate: null,
      receivedDate: "2026-03-02",
      completedDate: null,
      notes: null,
    },
    null
  );
  linkDonationLegs(db, { donationId, outTransactionId: out });
  computeTaxLots(db);
  return { donationId, buyId };
}

/** The screen's `send`, wired straight to the real route handler. */
async function lotsSender(donationId: number, assignments: unknown) {
  const mod = await import("@/app/api/donations/[id]/lots/route");
  const calls: boolean[] = [];
  const send = (acknowledged: boolean) => {
    calls.push(acknowledged);
    return mod.POST(
      new NextRequest(`http://test/api/donations/${donationId}/lots`, {
        method: "POST",
        body: JSON.stringify(withLedgerAck({ assignments }, acknowledged)),
      }),
      { params: Promise.resolve({ id: String(donationId) }) }
    );
  };
  return { send, calls };
}

function assigned(): number {
  return (hoisted.db.prepare("SELECT COUNT(*) AS n FROM donation_lots").get() as { n: number }).n;
}

describe("LedgerFlowController against the real lots route", () => {
  it("first click asks, shows the real census and saves nothing", async () => {
    const { donationId, buyId } = seedBook();
    const { send, calls } = await lotsSender(donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const flow = new LedgerFlowController();
    const pending = flow.start({ title: "Saving these lot assignments", send });
    expect(flow.getPhase().kind).toBe("checking");
    await pending;

    const phase = flow.getPhase();
    expect(phase.kind).toBe("confirm");
    if (phase.kind !== "confirm") throw new Error("unreachable");
    expect(phase.census).toEqual(getLedgerCensus(hoisted.db));
    expect(phase.census).toEqual({ closedSales: 1, openLots: 2, engineCloses: 0 });
    expect(calls).toEqual([false]);
    expect(assigned()).toBe(0);
  });

  it("cancel at the confirm step saves nothing and reports not-saved", async () => {
    const { donationId, buyId } = seedBook();
    const { send, calls } = await lotsSender(donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const flow = new LedgerFlowController();
    const closed: boolean[] = [];
    await flow.start({ title: "Saving these lot assignments", send, onClosed: (saved) => closed.push(saved) });
    expect(flow.close()).toBe(true);
    expect(flow.getPhase().kind).toBe("idle");
    expect(closed).toEqual([false]);
    expect(calls).toEqual([false]);
    expect(assigned()).toBe(0);
    // Nothing left armed: a later confirm with no dialog does nothing.
    expect(flow.proceed()).toBeNull();
    expect(calls).toEqual([false]);
  });

  it("confirm runs the recompute once and reports counts that match the database", async () => {
    const { donationId, buyId } = seedBook();
    const { send, calls } = await lotsSender(donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const flow = new LedgerFlowController();
    const closed: boolean[] = [];
    await flow.start({ title: "Saving these lot assignments", send, onClosed: (saved) => closed.push(saved) });
    const before = getLedgerCensus(hoisted.db);

    const running = flow.proceed();
    expect(flow.getPhase().kind).toBe("running");
    // A second click on Save-and-recompute, a click on Save behind the dialog
    // and a press of Escape while it runs: all ignored.
    expect(flow.proceed()).toBeNull();
    expect(flow.start({ title: "again", send })).toBeNull();
    expect(flow.close()).toBe(false);
    expect(flow.getPhase().kind).toBe("running");
    await running;

    const phase = flow.getPhase();
    expect(phase.kind).toBe("done");
    if (phase.kind !== "done") throw new Error("unreachable");
    expect(phase.recomputed).toBe(true);
    expect(phase.report?.before).toEqual(before);
    expect(phase.report?.after).toEqual(getLedgerCensus(hoisted.db));
    expect(calls).toEqual([false, true]);
    expect(assigned()).toBe(1);
    expect(closed).toEqual([]); // the page refreshes only when the result is closed
    expect(flow.close()).toBe(true);
    expect(closed).toEqual([true]);
  });

  it("a second click while the first check is still out sends nothing more", async () => {
    const { donationId, buyId } = seedBook();
    const { send, calls } = await lotsSender(donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const flow = new LedgerFlowController();
    const first = flow.start({ title: "Saving these lot assignments", send });
    expect(flow.start({ title: "Saving these lot assignments", send })).toBeNull();
    expect(flow.proceed()).toBeNull();
    await first;
    expect(calls).toEqual([false]);
  });

  it("a change the server rejects after the confirm is shown as not saved, with its reason", async () => {
    const { donationId } = seedBook();
    const { send } = await lotsSender(donationId, [{ acquisitionTransactionId: 999999, quantity: 40 }]);
    const flow = new LedgerFlowController();
    const closed: boolean[] = [];
    await flow.start({ title: "Saving these lot assignments", send, onClosed: (saved) => closed.push(saved) });
    await flow.proceed();
    const phase = flow.getPhase();
    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("unreachable");
    expect(phase.saved).toBe("no");
    expect(phase.message).toContain("not found");
    expect(assigned()).toBe(0);
    flow.close();
    expect(closed).toEqual([false]);
  });

  it("a recompute that fails half-way is reported as saved-but-not-recomputed with an unchanged ledger", async () => {
    const { donationId, buyId } = seedBook();
    hoisted.db.exec(
      `CREATE TRIGGER flow_boom BEFORE INSERT ON tax_lot_sales BEGIN SELECT RAISE(ABORT, 'engine boom'); END`
    );
    const { send } = await lotsSender(donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const flow = new LedgerFlowController();
    await flow.start({ title: "Saving these lot assignments", send });
    await flow.proceed();
    const phase = flow.getPhase();
    expect(phase.kind).toBe("done");
    if (phase.kind !== "done") throw new Error("unreachable");
    expect(phase.recomputed).toBe(false);
    expect(phase.recomputeError).toContain("engine boom");
    expect(phase.report?.after).toEqual(phase.report?.before);
    expect(assigned()).toBe(1);

    const html = renderToStaticMarkup(<LedgerRecomputeBody phase={phase} />);
    expect(html).toContain("Saved, but the ledger was not recomputed");
    expect(html).toContain("exactly as it was before");
    expect(html).not.toContain("The ledger was recomputed");
  });
});

describe("a gift re-pointed to another lot", () => {
  it("is shown as moved open lots, never as nothing moved", async () => {
    const db = hoisted.db;
    const sec = db.prepare("INSERT INTO securities (symbol, currency) VALUES ('ZZFF', 'USD')").run().lastInsertRowid as number;
    const lot1 = txn(sec, "2026-01-05", "BUY", 100, 10);
    const lot2 = txn(sec, "2026-01-20", "BUY", 100, 30);
    const out = txn(sec, "2026-03-02", "TRANSFER_OUT", 60, 0);
    const donationId = insertDonation(
      db,
      {
        sourceKey: `flow-don-${++seq}`, kind: "stock", securityId: sec, symbolRaw: "ZZFF", quantity: 60,
        fmvUsd: 6000, unitValuation: null, createdDate: null, receivedDate: "2026-03-02", completedDate: null, notes: null,
      },
      null
    );
    linkDonationLegs(db, { donationId, outTransactionId: out });
    computeTaxLots(db);
    const run = async (lot: number) => {
      const { send } = await lotsSender(donationId, [{ acquisitionTransactionId: lot, quantity: 60 }]);
      const flow = new LedgerFlowController();
      await flow.start({ title: "Saving these lot assignments", send });
      await flow.proceed();
      return flow.getPhase();
    };
    await run(lot1);
    const phase = await run(lot2);
    if (phase.kind !== "done") throw new Error("unreachable");
    expect(phase.report?.before).toEqual(phase.report?.after);
    expect(phase.report?.openLotsChanged).toBe(2);
    const html = renderToStaticMarkup(<LedgerRecomputeBody phase={phase} />);
    expect(html).not.toContain("Nothing moved");
    expect(html).toContain("Open lots changed");
  });
});

describe("LedgerFlowController when the connection fails", () => {
  it("no answer to the first request: nothing was saved, and it says so", async () => {
    const flow = new LedgerFlowController();
    const closed: boolean[] = [];
    await flow.start({
      title: "Unlinking this donation",
      send: () => Promise.reject(new TypeError("Failed to fetch")),
      onClosed: (saved) => closed.push(saved),
    });
    const phase = flow.getPhase();
    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("unreachable");
    expect(phase.saved).toBe("no");
    expect(phase.message).toContain("Nothing was saved");
    expect(phase.message).not.toContain("Failed to fetch");
    flow.close();
    expect(closed).toEqual([false]);
  });

  it("no answer to the CONFIRMED request: says it may have been saved and re-reads the page", async () => {
    const refusal = () =>
      Response.json(
        {
          success: false,
          error: "confirm",
          code: "ledger_recompute_unacknowledged",
          data: { ledger: { closedSales: 3, openLots: 2, engineCloses: 1 }, acceptedTaxYearsAffected: 0 },
        },
        { status: 409 }
      );
    const flow = new LedgerFlowController();
    const closed: boolean[] = [];
    await flow.start({
      title: "Unlinking this donation",
      send: (acknowledged) => (acknowledged ? Promise.reject(new TypeError("Failed to fetch")) : Promise.resolve(refusal())),
      onClosed: (saved) => closed.push(saved),
    });
    await flow.proceed();
    const phase = flow.getPhase();
    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("unreachable");
    expect(phase.saved).toBe("unknown");
    expect(phase.message).toContain("may have been saved");
    expect(phase.message).not.toContain("Failed to fetch");
    flow.close();
    expect(closed).toEqual([true]);
  });

  it("a non-JSON 500 and a 409 that is NOT the recompute refusal are plain failures, never a confirm prompt", async () => {
    for (const res of [
      new Response("<html>Internal Server Error</html>", { status: 500 }),
      Response.json({ success: false, error: "donation 7: already linked — unlink first" }, { status: 409 }),
      Response.json({ success: false, code: "ledger_recompute_unacknowledged", data: { ledger: { closedSales: "3" } } }, { status: 409 }),
      // A census with no accepted-year count is malformed too: never guess it is zero.
      Response.json(
        { success: false, code: "ledger_recompute_unacknowledged", data: { ledger: { closedSales: 3, openLots: 2, engineCloses: 1 } } },
        { status: 409 }
      ),
    ]) {
      const flow = new LedgerFlowController();
      await flow.start({ title: "Confirming this match", send: () => Promise.resolve(res) });
      const phase = flow.getPhase();
      expect(phase.kind).toBe("failed");
      expect(flow.proceed()).toBeNull();
    }
  });

  it("a server that keeps asking after the confirmation does not loop", async () => {
    const refusal = () =>
      Response.json(
        {
          success: false,
          error: "confirm",
          code: "ledger_recompute_unacknowledged",
          data: { ledger: { closedSales: 3, openLots: 2, engineCloses: 1 }, acceptedTaxYearsAffected: 0 },
        },
        { status: 409 }
      );
    let sends = 0;
    const flow = new LedgerFlowController();
    await flow.start({
      title: "Resolving this symbol",
      send: () => {
        sends++;
        return Promise.resolve(refusal());
      },
    });
    await flow.proceed();
    expect(flow.getPhase().kind).toBe("failed");
    expect(sends).toBe(2);
  });

  it("busy means a request is out, and only then", () => {
    const census = { closedSales: 1, openLots: 1, engineCloses: 0 };
    expect(isLedgerFlowBusy({ kind: "idle" })).toBe(false);
    expect(isLedgerFlowBusy({ kind: "checking", title: "x" })).toBe(true);
    expect(isLedgerFlowBusy({ kind: "confirm", title: "x", census, acceptedTaxYearsAffected: 0 })).toBe(false);
    expect(isLedgerFlowBusy({ kind: "running", title: "x", census })).toBe(true);
  });
});

describe("withLedgerAck", () => {
  it("adds the flag only for the confirmed request and never mutates the body", () => {
    const body = { assignments: [] as unknown[] };
    expect(withLedgerAck(body, false)).toEqual({ assignments: [] });
    expect(withLedgerAck(body, true)).toEqual({ assignments: [], acknowledgeLedgerRecompute: true });
    expect(body).toEqual({ assignments: [] });
  });
});

describe("LedgerRecomputeBody", () => {
  const census = { closedSales: 4321, openLots: 987, engineCloses: 65 };
  const confirm: LedgerFlowPhase = {
    kind: "confirm",
    title: "Saving these lot assignments",
    census,
    acceptedTaxYearsAffected: 0,
  };
  const done: LedgerFlowPhase = {
    kind: "done",
    title: "Saving these lot assignments",
    recomputed: true,
    recomputeError: null,
    report: {
      before: census,
      after: { closedSales: 4322, openLots: 986, engineCloses: 66 },
      saleRowsAddedOrChanged: 7531,
      saleRowsRemovedOrChanged: 7530,
      openLotsChanged: 2468,
    },
  };

  it("the confirm step says it is the ENTIRE ledger, shows the counts and that nothing is saved yet", () => {
    const html = renderToStaticMarkup(<LedgerRecomputeBody phase={confirm} />);
    expect(html).toContain("Saving these lot assignments recomputes the entire tax-lot ledger");
    expect(html).toContain("not just this gift");
    expect(html).toContain("4,321");
    expect(html).toContain("987");
    expect(html).toContain("65");
    expect(html).toContain("Nothing has been");
    expect(html).toContain("cannot be cancelled once it starts");
  });

  it("the running step is a live status that says it is running", () => {
    const html = renderToStaticMarkup(
      <LedgerRecomputeBody phase={{ kind: "running", title: "Saving these lot assignments", census }} />
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Recomputing the entire tax-lot ledger");
    expect(html).toContain("Keep this window open");
  });

  it("the result shows before and after for all three counts and the changed sale rows", () => {
    const html = renderToStaticMarkup(<LedgerRecomputeBody phase={done} />);
    for (const figure of ["4,321", "4,322", "987", "986", "65", "66", "7,531", "7,530", "2,468"]) {
      expect(html).toContain(figure);
    }
    expect(html).toContain("This is what moved");
    expect(html).toContain("Open lots changed");
    // The Tax Lots page's own word for an engine-made close, and closed sales say they include them.
    expect(html).toContain("Estimated closes");
    expect(html).toContain("Closed sales (Estimated closes included)");
    expect(html).not.toContain("Engine-made");
  });

  it("an unchanged ledger is reported as nothing moved, not as silence", () => {
    const html = renderToStaticMarkup(
      <LedgerRecomputeBody
        phase={{
          ...done,
          kind: "done",
          report: { before: census, after: census, saleRowsAddedOrChanged: 0, saleRowsRemovedOrChanged: 0, openLotsChanged: 0 },
        } as LedgerFlowPhase}
      />
    );
    expect(html).toContain("Nothing moved");
  });

  it("equal counts with a changed open lot is NOT nothing moved", () => {
    const html = renderToStaticMarkup(
      <LedgerRecomputeBody
        phase={{
          ...done,
          kind: "done",
          report: { before: census, after: census, saleRowsAddedOrChanged: 0, saleRowsRemovedOrChanged: 0, openLotsChanged: 2 },
        } as LedgerFlowPhase}
      />
    );
    expect(html).not.toContain("Nothing moved");
    expect(html).toContain("This is what moved");
    expect(html).toContain("Open lots changed");
  });

  it("the confirm step names accepted tax years only when there are some", () => {
    const sentence = "will go back to not-for-filing until they are reconciled again";
    expect(renderToStaticMarkup(<LedgerRecomputeBody phase={confirm} />)).not.toContain("not-for-filing");
    const html = renderToStaticMarkup(
      <LedgerRecomputeBody phase={{ ...confirm, kind: "confirm", acceptedTaxYearsAffected: 3 } as LedgerFlowPhase} />
    );
    expect(html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toContain(`3 accepted account tax year(s) ${sentence}`);
    mockPrivate = true;
    const hidden = renderToStaticMarkup(
      <LedgerRecomputeBody phase={{ ...confirm, kind: "confirm", acceptedTaxYearsAffected: 3 } as LedgerFlowPhase} />
    );
    expect(hidden.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toContain(`••• accepted account tax year(s) ${sentence}`);
  });

  it("says how long in words that do not sound measured", () => {
    const html =
      renderToStaticMarkup(<LedgerRecomputeBody phase={confirm} />) +
      renderToStaticMarkup(<LedgerRecomputeBody phase={{ kind: "running", title: "x", census }} />);
    expect(html).toContain("can take a while on a large ledger");
    expect(html).not.toContain("few minutes");
  });

  it("a result with no counts says so instead of printing zeros", () => {
    const html = renderToStaticMarkup(
      <LedgerRecomputeBody phase={{ ...done, kind: "done", report: null } as LedgerFlowPhase} />
    );
    expect(html).toContain("sent no before-and-after counts");
    expect(html).not.toContain("<table");
  });

  it("under Hide amounts no ledger count reaches the markup", () => {
    mockPrivate = true;
    const html =
      renderToStaticMarkup(<LedgerRecomputeBody phase={confirm} />) +
      renderToStaticMarkup(<LedgerRecomputeBody phase={done} />);
    for (const figure of ["4,321", "4321", "4,322", "987", "986", "7,531", "7531", "7,530", "2,468", "2468"]) {
      expect(html).not.toContain(figure);
    }
    expect(html).toContain("•••");
  });

  it("idle draws nothing", () => {
    expect(renderToStaticMarkup(<LedgerRecomputeBody phase={{ kind: "idle" }} />)).toBe("");
  });
});

// ── Source pins ────────────────────────────────────────────────────────────

const GIVING = "app/dashboard/components/giving";
const read = (file: string) => readFileSync(`${GIVING}/${file}`, "utf8");

function count(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

describe("every Giving mutation is sent through the recompute flow", () => {
  const files: [string, number][] = [
    ["LotAssignmentDrawer.tsx", 1],
    ["GivingYearSection.tsx", 3],
    ["ReconciliationStrip.tsx", 1],
  ];

  for (const [file, mutations] of files) {
    it(`${file}: ${mutations} mutation(s), each inside flow.start with a conditional acknowledgement`, () => {
      const src = read(file);
      expect(count(src, "flow.start({")).toBe(mutations);
      expect(count(src, "withLedgerAck(")).toBe(mutations);
      // No mutating request to a donation route outside a flow.start block.
      const mutatingCalls = count(src, 'method: "POST"') + count(src, 'method: "DELETE"');
      expect(mutatingCalls).toBe(mutations);
      let from = 0;
      for (let i = 0; i < mutations; i++) {
        const start = anchorIndex(src, "flow.start({", from, `${file} flow.start #${i + 1}`);
        const end = anchorIndex(src, "onClosed:", start, `${file} onClosed #${i + 1}`);
        const block = src.slice(start, end);
        expect(block).toContain("send: (acknowledged) =>");
        expect(block).toContain("apiFetch(`/api/donations/${donationId}/");
        expect(block).toMatch(/withLedgerAck\(\{[^)]*\}, acknowledged\)/);
        from = end;
      }
      // The flag is never hard-wired on a screen, and no screen reads a
      // mutation response by hand any more.
      expect(src).not.toContain("acknowledgeLedgerRecompute");
      expect(src).not.toContain("LEDGER_RECOMPUTE_ACK_FIELD");
      // (The drawer's one remaining `res.ok` is its GET of the open lots, a read.)
      expect(count(src, "res.ok")).toBe(file === "LotAssignmentDrawer.tsx" ? 1 : 0);
      expect(src).not.toContain("recomputed === false");
      expect(src).toContain("<LedgerRecomputeDialog flow={flow} />");
    });
  }

  it("the flow reads every response through readMutationResult and never prints a raw exception", () => {
    const src = read("ledger-recompute-flow.ts");
    const reader = sliceBetween(src, "export async function readLedgerFlowResponse", "export function ledgerFlowNetworkFailure");
    expect(reader).toContain("await readMutationResult");
    expect(src).toContain("networkFailureMessage(");
    expect(src).not.toContain("err.message");
    expect(src).not.toContain("error.message");
  });

  it("the drawer cannot be closed, and its buttons cannot be clicked, while the dialog is up", () => {
    const src = read("LotAssignmentDrawer.tsx");
    const escape = sliceBetween(src, "function handleKey(e: KeyboardEvent)", "document.addEventListener");
    expect(escape).toContain("!flowActive");
    const clear = sliceBetween(src, "onClick={handleClear}", "Clear assignments");
    expect(clear).toContain("disabled={flowActive}");
    const save = sliceBetween(src, "onClick={handleSave}", "Save\n");
    expect(save).toContain("disabled={flowActive ||");
    const backdrop = sliceBetween(src, 'className="fixed inset-0 z-[55] flex"', 'role="dialog"');
    expect(backdrop).toContain("if (!flowActive) onClose()");
    // The drawer closes itself only for a saved change.
    const closed = sliceBetween(src, "onClosed: (saved) => {", "});");
    expect(closed).toContain("if (!saved) return;");
    expect(closed).toContain("onClose()");
  });

  it("the dialog offers no button while a request is out, and Escape goes through close()", () => {
    const src = read("LedgerRecomputeDialog.tsx");
    const busy = sliceBetween(src, "{busy && (", ")}");
    expect(busy).not.toContain("<button");
    const cancel = sliceBetween(src, "const handleCancel = (e: Event) => {", "dialog.addEventListener");
    expect(cancel).toContain("e.preventDefault()");
    expect(cancel).toContain("close()");
    expect(src).toContain("m-auto");
  });
});

describe("GivingYearSection: implausible basis", () => {
  const src = read("GivingYearSection.tsx");

  it("the row chip reads the one server-side flag", () => {
    const chip = sliceBetween(src, "{gd.basisImplausible && !struck && (", ")}");
    expect(chip).toContain('<Chip tone="warn">basis implausible, verify</Chip>');
    // The screen never re-derives the rule.
    expect(src).not.toContain("isDonatedLotBasisImplausible");
    expect(src).not.toMatch(/0\.01|\* 100/);
  });

  it("the year header says how many rows were left out, through the privacy component", () => {
    const note = sliceBetween(src, "{year.gainAvoidedRowsLeftOut > 0 && (", ")}");
    expect(note).toContain("rows left out for an implausible basis");
    expect(note).toContain("<Count value={year.gainAvoidedRowsLeftOut}");
    const total = sliceBetween(src, "{year.gainAvoided == null ? (", "{year.gainAvoidedRowsLeftOut > 0 && (");
    expect(total).toContain("year.gainAvoidedRowsCounted === 0");
    expect(total).toContain("not shown");
    expect(total).toContain("<Money value={year.gainAvoided}");
  });
});
