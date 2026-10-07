/**
 * The Giving page's "basis verified" control (owner request 2026-10-07).
 *
 * Three layers, as in giving-ledger-recompute-flow.test.tsx:
 *  1. the request helpers driven against the REAL route on an in-memory
 *     database: mark, undo, nothing to undo, refusals, a dropped connection,
 *     a double click;
 *  2. the chip block and the form rendered to static markup: the words, the
 *     tooltip, privacy mode;
 *  3. source pins: how the handlers are written and where the control sits.
 *
 * There is no DOM harness in this repo, so a click is a direct call.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView, type GivingFlaggedLot } from "@/lib/queries/giving-view";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { bumpTaxInputGeneration } from "@/lib/compute/tax-convention";
import { SOURCE_NOTE_MAX_LENGTH as SERVER_NOTE_MAX } from "@/lib/mutations/lot-basis-verifications";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { seedFlaggedGift, seedPlausibleGift } from "../helpers/giving-basis-fixture";

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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import {
  LOT_BASIS_CHIP_LABEL,
  NOTHING_TO_UNDO_MESSAGE,
  SOURCE_NOTE_MAX_LENGTH,
  createBusyGuard,
  sendMarkBasisVerified,
  sendUnmarkBasisVerified,
  sourceNoteProblem,
  verificationSummary,
  verifiedOnET,
  type LotBasisFetch,
} from "@/app/dashboard/components/giving/lot-basis-actions";
import { BasisVerifiedDialog, LotBasisStatus } from "@/app/dashboard/components/giving/LotBasisControl";
import { GivingYearSection } from "@/app/dashboard/components/giving/GivingYearSection";

beforeEach(() => {
  mockPrivate = false;
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

/** A fetch that hands each request to the real route handler. */
function routeFetch(): { fetcher: LotBasisFetch; calls: { url: string; method: string; body: unknown }[] } {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetcher: LotBasisFetch = async (input, init) => {
    const route = await import("@/app/api/donations/lots/[acquisitionTransactionId]/basis-verified/route");
    const match = /^\/api\/donations\/lots\/([^/]+)\/basis-verified$/.exec(input);
    if (!match) throw new Error(`unexpected url ${input}`);
    const method = init?.method ?? "GET";
    calls.push({ url: input, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const request = new NextRequest(`http://localhost${input}`, {
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    const ctx = { params: Promise.resolve({ acquisitionTransactionId: match[1] }) };
    if (method === "POST") return route.POST(request, ctx);
    if (method === "DELETE") return route.DELETE(request, ctx);
    throw new Error(`unexpected method ${method}`);
  };
  return { fetcher, calls };
}

const year = () => getGivingView(hoisted.db).years[0];
const markers = () =>
  (hoisted.db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get() as { c: number }).c;

// ── 1. The requests, against the real route ────────────────────────────────

describe("sendMarkBasisVerified / sendUnmarkBasisVerified against the real route", () => {
  it("mark, then undo, then undo again", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    const { fetcher, calls } = routeFetch();
    expect(year().gainAvoidedRowsLeftOut).toBe(1);

    expect(await sendMarkBasisVerified(fetcher, bad.lotTxn, "synthetic source, 2020")).toEqual({
      ok: true,
      message: null,
    });
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
    // No acknowledgement flag is ever sent: there is no recompute to agree to.
    expect(calls[0]).toEqual({
      url: `/api/donations/lots/${bad.lotTxn}/basis-verified`,
      method: "POST",
      body: { sourceNote: "synthetic source, 2020" },
    });

    expect(await sendUnmarkBasisVerified(fetcher, bad.lotTxn)).toEqual({ ok: true, message: null });
    expect(year().gainAvoidedRowsLeftOut).toBe(1);

    expect(await sendUnmarkBasisVerified(fetcher, bad.lotTxn)).toEqual({ ok: true, message: NOTHING_TO_UNDO_MESSAGE });
    expect(NOTHING_TO_UNDO_MESSAGE.toLowerCase()).toContain("nothing to undo");
  });

  it("a refusal comes back as the server's own plain words, and nothing is saved", async () => {
    const good = seedPlausibleGift(hoisted.db);
    const { fetcher } = routeFetch();
    const empty = await sendMarkBasisVerified(fetcher, good.lotTxn, "   ");
    expect(empty).toEqual({ ok: false, message: "Say what you checked the basis against." });
    const missing = await sendMarkBasisVerified(fetcher, 999999, "synthetic source");
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain("not found");
    expect(markers()).toBe(0);
  });

  it("a ledger waiting on a recompute comes back as that plain reason", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    bumpTaxInputGeneration(hoisted.db);
    const { fetcher } = routeFetch();
    expect(await sendMarkBasisVerified(fetcher, bad.lotTxn, "synthetic source")).toEqual({
      ok: false,
      message:
        "The tax-lot ledger is waiting on a recompute, so the basis shown may be out of date. Recompute first, then verify.",
    });
    expect(markers()).toBe(0);
  });

  it("a dropped connection is explained, never printed raw", async () => {
    const dropped: LotBasisFetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const mark = await sendMarkBasisVerified(dropped, 1, "synthetic source");
    const undo = await sendUnmarkBasisVerified(dropped, 1);
    for (const result of [mark, undo]) {
      expect(result.ok).toBe(false);
      expect(result.message).toContain("could not reach the server");
      expect(result.message).not.toContain("Failed to fetch");
    }
  });

  it("a non-JSON 500 and a 200 that does not say success are failures", async () => {
    const html: LotBasisFetch = async () => new Response("<html>Internal Server Error</html>", { status: 500 });
    expect(await sendMarkBasisVerified(html, 1, "s")).toEqual({
      ok: false,
      message: "The server returned an error (HTTP 500).",
    });
    const liar: LotBasisFetch = async () => Response.json({ success: false, error: "no" });
    expect(await sendUnmarkBasisVerified(liar, 1)).toEqual({ ok: false, message: "no" });
  });

  it("a second click while the first request is out sends nothing more", async () => {
    const bad = seedFlaggedGift(hoisted.db);
    const { fetcher, calls } = routeFetch();
    const guard = createBusyGuard();
    const first = guard.run(() => sendMarkBasisVerified(fetcher, bad.lotTxn, "synthetic source"));
    expect(guard.run(() => sendMarkBasisVerified(fetcher, bad.lotTxn, "synthetic source"))).toBeNull();
    expect(guard.run(() => sendUnmarkBasisVerified(fetcher, bad.lotTxn))).toBeNull();
    await first;
    expect(calls).toHaveLength(1);
    // Free again once the answer is in, and after a failure too.
    await guard.run(() => Promise.reject(new Error("boom")))?.catch(() => {});
    expect(guard.run(() => Promise.resolve(1))).not.toBeNull();
  });
});

describe("the wording helpers", () => {
  it("the note check matches the server's limit", () => {
    expect(SOURCE_NOTE_MAX_LENGTH).toBe(SERVER_NOTE_MAX);
    expect(sourceNoteProblem("")).toMatch(/what you checked/);
    expect(sourceNoteProblem("  \n ")).toMatch(/what you checked/);
    expect(sourceNoteProblem(` ${"x".repeat(200)} `)).toBeNull();
    expect(sourceNoteProblem("x".repeat(201))).toContain("200");
    expect(sourceNoteProblem("synthetic source")).toBeNull();
  });

  it("the verification date is an Eastern-time calendar day", () => {
    // 03:30 UTC on the 8th is 23:30 on the 7th in New York (daylight time).
    expect(verifiedOnET("2026-10-08 03:30:00")).toBe("2026-10-07");
    // 03:30 UTC on Jan 8th is 22:30 on the 7th (standard time).
    expect(verifiedOnET("2026-01-08 03:30:00")).toBe("2026-01-07");
    expect(verifiedOnET("2026-10-08 12:00:00")).toBe("2026-10-08");
    expect(verifiedOnET(null)).toBeNull();
    expect(verifiedOnET("not a date")).toBeNull();
  });

  it("the summary carries the note and the date, or nothing without a marker", () => {
    expect(verificationSummary({ sourceNote: "synthetic source", verifiedAt: "2026-10-08 03:30:00" })).toBe(
      "Source: synthetic source · verified 2026-10-07"
    );
    expect(verificationSummary({ sourceNote: "synthetic source", verifiedAt: "garbled" })).toBe(
      "Source: synthetic source"
    );
    expect(verificationSummary({ sourceNote: null, verifiedAt: null })).toBeNull();
  });
});

// ── 2. What is drawn ───────────────────────────────────────────────────────

const lot = (over: Partial<GivingFlaggedLot>): GivingFlaggedLot => ({
  acquisitionTransactionId: 7,
  acquisitionDate: "2010-01-10",
  state: "implausible",
  sourceNote: null,
  verifiedAt: null,
  ...over,
});

const status = (l: GivingFlaggedLot, notice: { tone: "error" | "info"; text: string } | null = null, busy = false) =>
  renderToStaticMarkup(<LotBasisStatus lot={l} busy={busy} notice={notice} onMark={() => {}} onUndo={() => {}} />);

describe("LotBasisStatus", () => {
  it("implausible: the warn chip and a visible Mark basis verified button", () => {
    const html = status(lot({}));
    expect(html).toContain("basis implausible, verify");
    expect(html).toContain("bg-warn/20 text-warn");
    expect(html).toContain("Lot acquired 2010-01-10");
    expect(html).toContain(">Mark basis verified</button>");
    expect(html).not.toContain("Undo");
    expect(html).not.toContain("Source:");
    // Visible without a hover: no opacity-0 / group-hover reveal.
    expect(html).not.toMatch(/opacity-0|group-hover|invisible/);
  });

  it("verified: a quiet chip, the note and date as tooltip AND as visible text, and Undo", () => {
    const html = status(lot({ state: "verified", sourceNote: "synthetic source", verifiedAt: "2026-10-08 03:30:00" }));
    expect(html).toContain(">basis verified</span>");
    expect(html).toContain("bg-raised text-ink-dim");
    expect(html).not.toContain("bg-warn");
    expect(html).toContain('title="Source: synthetic source · verified 2026-10-07"');
    expect(html).toContain("<span>Source: synthetic source · verified 2026-10-07</span>");
    expect(html).toContain(">Undo</button>");
    expect(html).toContain('aria-label="Undo basis verified for the lot acquired 2010-01-10"');
    expect(html).not.toContain("Mark basis verified");
  });

  it("verified-stale: its own warn chip, the old source, and Mark basis verified again", () => {
    const html = status(
      lot({ state: "verified-stale", sourceNote: "synthetic source", verifiedAt: "2026-10-08 03:30:00" })
    );
    expect(html).toContain("basis changed since verified, verify again");
    expect(html).toContain("bg-warn/20 text-warn");
    expect(html).toContain("Source: synthetic source · verified 2026-10-07");
    expect(html).toContain("has changed since then");
    expect(html).toContain(">Mark basis verified</button>");
    expect(html).not.toContain(">Undo</button>");
  });

  it("privacy mode masks the note and shows no tooltip", () => {
    mockPrivate = true;
    const html = status(lot({ state: "verified", sourceNote: "synthetic source", verifiedAt: "2026-10-08 03:30:00" }));
    expect(html).not.toContain("synthetic source");
    expect(html).not.toContain("title=");
    expect(html).toContain("basis verified");
  });

  it("a failure is an alert, a no-op is a status line, and busy disables the button", () => {
    const failed = status(lot({ state: "verified", sourceNote: "s" }), { tone: "error", text: "It did not work." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("It did not work.");
    const noop = status(lot({}), { tone: "info", text: NOTHING_TO_UNDO_MESSAGE }, true);
    expect(noop).toContain('role="status"');
    expect(noop).toContain("Nothing to undo");
    expect(noop).toMatch(/<button[^>]*disabled=""[^>]*>Mark basis verified/);
  });

  it("every chip label is plain words", () => {
    expect(LOT_BASIS_CHIP_LABEL).toEqual({
      implausible: "basis implausible, verify",
      verified: "basis verified",
      "verified-stale": "basis changed since verified, verify again",
    });
  });
});

describe("BasisVerifiedDialog", () => {
  const dialog = (over: { note?: string; busy?: boolean; error?: string | null } = {}) =>
    renderToStaticMarkup(
      <BasisVerifiedDialog
        open
        symbol="ZZBB"
        acquisitionDate="2010-01-10"
        note={over.note ?? ""}
        busy={over.busy ?? false}
        error={over.error ?? null}
        onNoteChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />
    );

  it("is a centred dialog with one required, labelled text field and Save / Cancel", () => {
    const html = dialog();
    expect(html).toMatch(/<dialog class="m-auto /);
    expect(html).toContain("Source (for example: final K-1, 2020)");
    expect(html).toMatch(/<label for="([^"]+)"[^>]*>Source/);
    const id = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<input id="${id}"`);
    expect(html).toMatch(/<input[^>]*type="text"[^>]*required=""[^>]*maxLength="200"/);
    expect(html).toContain(">Cancel</button>");
    expect(html).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
    expect(html).toContain("ZZBB lot acquired 2010-01-10");
    expect(html).toContain("It changes no tax figure and does not recompute the ledger.");
  });

  it("Save is disabled until there is something to save, and while a save is out", () => {
    expect(dialog()).toMatch(/<button type="submit" disabled=""/);
    expect(dialog({ note: "   " })).toMatch(/<button type="submit" disabled=""/);
    expect(dialog({ note: "synthetic source" })).not.toMatch(/<button type="submit" disabled=""/);
    const busy = dialog({ note: "synthetic source", busy: true });
    expect(busy).toMatch(/<button type="submit" disabled=""[^>]*>Saving…/);
    expect(busy).toMatch(/<button type="button" disabled=""[^>]*>Cancel/);
  });

  it("an empty or whitespace-only field says why Save is disabled, tied to the input", () => {
    for (const note of ["", "   "]) {
      const html = dialog({ note });
      const hint = /<p id="([^"]+)" class="text-xs text-ink-dim[^"]*">Enter where you checked this basis, then save\.<\/p>/.exec(html);
      expect(hint, JSON.stringify(note)).not.toBeNull();
      expect(html).toContain(`aria-describedby="${hint?.[1]}"`);
      expect(html).toMatch(/<button type="submit" disabled=""/);
    }
    const filled = dialog({ note: "synthetic source" });
    expect(filled).not.toContain("Enter where you checked this basis");
    expect(filled).not.toContain("aria-describedby");
  });

  it("a refusal is shown inside the form", () => {
    const html = dialog({ note: "x", error: "Transaction 9 was not found." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Transaction 9 was not found.");
  });
});

describe("GivingYearSection with the real view", () => {
  const render = () => renderToStaticMarkup(<GivingYearSection year={year()} />);

  it("the left-out line drops as lots are verified and is gone at zero", async () => {
    seedPlausibleGift(hoisted.db);
    const bad = seedFlaggedGift(hoisted.db);
    const { fetcher } = routeFetch();

    let html = render();
    expect(html).toContain("rows left out for an implausible basis");
    expect(html).toContain("basis implausible, verify");
    expect(html).toContain(">Mark basis verified</button>");

    await sendMarkBasisVerified(fetcher, bad.lotTxn, "synthetic source, 2020");
    html = render();
    expect(html).not.toContain("rows left out for an implausible basis");
    expect(html).not.toContain("basis implausible, verify");
    expect(html).toContain(">basis verified</span>");
    expect(html).toContain("Source: synthetic source, 2020 · verified ");
    expect(html).toContain(">Undo</button>");

    hoisted.db.prepare("UPDATE transactions SET amount = 2 WHERE id = ?").run(bad.lotTxn);
    computeTaxLots(hoisted.db);
    html = render();
    expect(html).toContain("rows left out for an implausible basis");
    expect(html).toContain("basis changed since verified, verify again");
  });

  it("an ordinary row shows no basis chip and no control", () => {
    seedPlausibleGift(hoisted.db);
    const html = render();
    expect(html).not.toContain("Mark basis verified");
    expect(html).not.toContain("basis verified");
    expect(html).not.toContain("Lot acquired");
  });
});

// ── 3. Source pins ─────────────────────────────────────────────────────────

const GIVING = "app/dashboard/components/giving";
const read = (file: string) => readFileSync(`${GIVING}/${file}`, "utf8");
const count = (src: string, needle: string) => src.split(needle).length - 1;

describe("how the control is written", () => {
  it("both requests are read through readMutationResult, with no bare res.ok and no raw exception text", () => {
    const src = read("lot-basis-actions.ts");
    const mark = sliceBetween(src, "export async function sendMarkBasisVerified", "export async function sendUnmarkBasisVerified");
    const undo = sliceBetween(src, "export async function sendUnmarkBasisVerified", "export function createBusyGuard");
    for (const block of [mark, undo]) {
      expect(block).toContain("await readMutationResult");
      expect(block).toContain("networkFailureMessage(");
      expect(block).toContain("basisVerifiedUrl(acquisitionTransactionId)");
    }
    expect(mark).toContain('method: "POST"');
    expect(undo).toContain('method: "DELETE"');
    for (const file of ["lot-basis-actions.ts", "LotBasisControl.tsx"]) {
      const text = read(file);
      expect(text).not.toContain("res.ok");
      expect(text).not.toContain("err.message");
      expect(text).not.toContain("error.message");
      expect(text).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
      // Never the recompute flow: a marker changes no tax input.
      expect(text).not.toContain("withLedgerAck");
      expect(text).not.toContain("flow.start");
      expect(text).not.toContain("acknowledgeLedgerRecompute");
    }
  });

  it("each handler is guarded against a double click and refreshes the page only after a saved change", () => {
    const src = read("LotBasisControl.tsx");
    const save = sliceBetween(src, "async function save() {", "async function undo() {");
    const undo = sliceBetween(src, "async function undo() {", "return (");
    for (const block of [save, undo]) {
      const guard = anchorIndex(block, "guard.run(", 0, "guard");
      const bail = anchorIndex(block, "if (!pending) return;", guard, "bail");
      const failed = anchorIndex(block, "if (!result.ok) {", bail, "failure branch");
      const refresh = anchorIndex(block, "router.refresh();", failed, "refresh");
      expect(block.slice(failed, refresh)).toContain("return;");
      expect(count(block, "router.refresh()")).toBe(1);
    }
    expect(save).toContain("sendMarkBasisVerified(apiFetch, lot.acquisitionTransactionId, note)");
    expect(save).toContain("setDialogError(result.message)");
    expect(undo).toContain("sendUnmarkBasisVerified(apiFetch, lot.acquisitionTransactionId)");
    expect(undo).toContain('setNotice({ tone: "error", text: result.message })');
    // Requests go through the CSRF-carrying wrapper, never a raw fetch.
    expect(src).not.toMatch(/[^A-Za-z]fetch\(/);
  });

  it("verifying again pre-fills the old source, except in privacy mode", () => {
    const src = read("LotBasisControl.tsx");
    const open = sliceBetween(src, "function openDialog() {", "function closeDialog() {");
    expect(open).toContain('setNote(isPrivate ? "" : (lot.sourceNote ?? ""));');
    const control = src.slice(anchorIndex(src, "export function LotBasisControl("));
    expect(control).toContain("const { isPrivate } = usePrivacy();");
    expect(src).toContain('placeholder="final K-1, 2020"');
  });

  it("the empty-field hint and the Save button read one flag", () => {
    const src = read("LotBasisControl.tsx");
    expect(src).toContain("const noteEmpty = note.trim().length === 0;");
    expect(src).toContain("aria-describedby={noteEmpty ? hintId : undefined}");
    const hint = sliceBetween(src, "{noteEmpty && (", ")}");
    expect(hint).toContain("<p id={hintId}");
    expect(hint).toContain("text-ink-dim");
    expect(src).toContain("disabled={busy || noteEmpty}");
  });

  it("Undo and Mark basis verified are 32px-tall tap targets that do not grow the row", () => {
    const src = read("LotBasisControl.tsx");
    expect(src).toContain('const ROW_ACTION_HIT_AREA = "inline-flex items-center min-h-8 -my-2";');
    const undo = sliceBetween(src, "onClick={onUndo}", "</button>");
    const mark = sliceBetween(src, "onClick={onMark}", "</button>");
    for (const button of [undo, mark]) expect(button).toContain("className={`${ROW_ACTION_HIT_AREA} text-xs ");
    // And in what is actually drawn.
    const undoHtml = status(lot({ state: "verified", sourceNote: "s" }));
    expect(undoHtml).toMatch(/<button[^>]*class="inline-flex items-center min-h-8 -my-2 [^"]*"[^>]*>Undo</);
    expect(status(lot({}))).toMatch(
      /<button[^>]*class="inline-flex items-center min-h-8 -my-2 [^"]*"[^>]*>Mark basis verified</
    );
  });

  it("no component is defined inside another, and the dialog is centred", () => {
    const src = read("LotBasisControl.tsx");
    // Every function component in the file starts at column 0.
    const components = src.match(/^[ \t]*(export )?function [A-Z]\w*\(/gm) ?? [];
    expect(components.length).toBe(3);
    for (const c of components) expect(c.startsWith("export function")).toBe(true);
    const dialog = sliceBetween(src, "<dialog", ">");
    expect(dialog).toContain('className="m-auto ');
    expect(src).toContain("whitespace-nowrap!");
  });

  it("the year section draws one control per flagged lot, never for a reversed gift, and re-derives nothing", () => {
    const src = read("GivingYearSection.tsx");
    const cell = sliceBetween(src, "<Chip tone={STATUS_TONE[gd.status]}>{STATUS_LABEL[gd.status]}</Chip>\n", "</td>");
    expect(cell).toContain("{!struck &&");
    expect(cell).toContain("gd.flaggedLots.map((lot) => (");
    expect(cell).toContain("key={lot.acquisitionTransactionId}");
    expect(src).not.toContain("donatedLotBasisState");
    expect(src).not.toContain("isDonatedLotBasisImplausible");
    expect(src).not.toContain("basis-verified");
  });

  it("the 1% predicate has one caller, the state reader", () => {
    const view = readFileSync("lib/queries/giving-view.ts", "utf8");
    expect(count(view, "isDonatedLotBasisImplausible(")).toBe(2); // its definition and the one call
    const reader = sliceBetween(view, "export function donatedLotBasisState", "\n}\n");
    expect(reader).toContain("if (!isDonatedLotBasisImplausible(input)) return \"plausible\";");
    // Two call sites, one reader: a lot in the ledger, and a marked lot that is gone from it.
    expect(count(view, "donatedLotBasisState({")).toBe(2);
    // The snapshot is compared with the figures the 1% rule reads, not with the transaction row.
    expect(reader).toContain("sameCents(verification.verifiedAmount, input.lotCostBasis)");
    expect(reader).toContain("sameQuantity(verification.verifiedQuantity, input.lotQuantityAcquired)");
  });
});
