/**
 * Giving: the lot drawer and the donation tables (QA unit B21).
 *
 *  1. the drawer's pure helpers: the opening picks, the over-assigned rule,
 *     the cost basis of the available shares;
 *  2. the confirm wording and the identity line rendered to static markup;
 *  3. source pins: Save is gated on the over-assigned rule, the close button
 *     carries a touch extension, the confirms name one donation.
 *
 * There is no DOM harness in this repo. Every figure here is invented.
 */

import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { GivingDonation } from "@/lib/queries/giving-view";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

let mockPrivate = false;
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: mockPrivate, setPrivate: () => {}, toggle: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import {
  OVER_ASSIGNED_MESSAGE,
  availableCostBasis,
  clampToLot,
  cleanShareQuantity,
  overAssignedLotIds,
  preloadSelections,
} from "@/app/dashboard/components/giving/LotAssignmentDrawer";
import { DonationIdentityLine, donationConfirmName } from "@/app/dashboard/components/giving/GivingYearSection";

const DRAWER = readFileSync("app/dashboard/components/giving/LotAssignmentDrawer.tsx", "utf8");
const SECTION = readFileSync("app/dashboard/components/giving/GivingYearSection.tsx", "utf8");

function lot(id: number, available: number, assigned = 0) {
  return { acquisitionTransactionId: id, remainingAsOfDonationDate: available, currentlyAssignedQuantity: assigned };
}

describe("opening picks carry no float noise", () => {
  it("a remainder computed as target minus the other lots is cleaned", () => {
    // 19 - 18.763 in binary floating point is not 0.237.
    const noisy = 19 - 18.763;
    expect(String(noisy)).not.toBe("0.237");
    expect(cleanShareQuantity(noisy)).toBe(0.237);
    expect(preloadSelections([lot(1, 40, noisy), lot(2, 50, 18.763)])).toEqual({ 1: 0.237, 2: 18.763 });
  });

  it("keeps real precision beyond four decimals", () => {
    expect(cleanShareQuantity(1.234567)).toBe(1.234567);
    expect(preloadSelections([lot(1, 5, 1.234567)])).toEqual({ 1: 1.234567 });
  });

  it("cleaning never pushes a pick over its lot", () => {
    // Saved a hair under a lot whose available quantity is itself noisy.
    const available = 0.1 + 0.2; // 0.30000000000000004
    const picks = preloadSelections([lot(1, available, available)]);
    expect(picks[1]).toBeLessThanOrEqual(available);
    expect(overAssignedLotIds(picks, [lot(1, available)])).toEqual([]);
    // A pick a hair OVER a clean lot (inside the server's tolerance) lands on the lot.
    const hairOver = preloadSelections([lot(2, 20, 20.000000000000004)]);
    expect(hairOver).toEqual({ 2: 20 });
    expect(overAssignedLotIds(hairOver, [lot(2, 20)])).toEqual([]);
  });

  it("skips unassigned lots", () => {
    expect(preloadSelections([lot(1, 10, 0), lot(2, 10)])).toEqual({});
  });
});

describe("a saved pick above the lot's available quantity", () => {
  const lots = [lot(1, 40, 300), lot(2, 60, 25)];

  it("is kept as saved, not quietly clamped, and is flagged", () => {
    const picks = preloadSelections(lots);
    expect(picks).toEqual({ 1: 300, 2: 25 });
    expect(overAssignedLotIds(picks, lots)).toEqual([1]);
  });

  it("clears once the quantity is reduced to the lot", () => {
    expect(overAssignedLotIds({ 1: clampToLot(300, 40), 2: 25 }, lots)).toEqual([]);
    expect(clampToLot(300, 40)).toBe(40);
  });

  it("uses the server's tolerance: exactly available passes, a real excess does not", () => {
    expect(overAssignedLotIds({ 1: 40 }, lots)).toEqual([]);
    expect(overAssignedLotIds({ 1: 40 + 1e-12 }, lots)).toEqual([]);
    expect(overAssignedLotIds({ 1: 40.0001 }, lots)).toEqual([1]);
    // The client constant is the server's.
    const server = readFileSync("lib/mutations/donation-links.ts", "utf8");
    expect(server).toContain("const EPS = 1e-9;");
    expect(DRAWER).toContain("const SHARE_EPS = 1e-9;");
  });

  it("Save is off, in the button and in the handler, and the page says why", () => {
    expect(DRAWER).toContain("disabled={flowActive || !lots || lots.length === 0 || overAssigned.length > 0}");
    const handler = sliceBetween(DRAWER, "function handleSave()", "function handleClear()");
    const guard = anchorIndex(handler, "if (overAssigned.length > 0)");
    expect(guard).toBeLessThan(anchorIndex(handler, "submit(assignments"));
    expect(DRAWER).toContain("<p className=\"text-xs text-down pt-2\">{OVER_ASSIGNED_MESSAGE}</p>");
    expect(OVER_ASSIGNED_MESSAGE).toMatch(/^Save is off/);
    expect(DRAWER).toContain("· exceeds available");
    expect(DRAWER).toContain("aria-invalid={over ? true : undefined}");
  });

  it("the drawer opens through preloadSelections, and an empty lot's saved pick can be unticked", () => {
    expect(DRAWER).toContain("setSelections(preloadSelections(json.data.lots));");
    expect(DRAWER).toContain("const disabled = lot.remainingAsOfDonationDate <= 0 && !checked;");
  });

  it("every other way a quantity enters the drawer is clamped and cleaned", () => {
    for (const fn of ["function toggleLot(", "function setQty(", "function applySuggestion("]) {
      const body = DRAWER.slice(anchorIndex(DRAWER, fn), anchorIndex(DRAWER, "\n  }\n", anchorIndex(DRAWER, fn)));
      expect(body, fn).toContain("clampToLot(");
    }
    expect(clampToLot(19 - 18.763, 40)).toBe(0.237);
  });

  it("the drawer still sends the acknowledgement flow, never a bare write", () => {
    expect(DRAWER).toContain("JSON.stringify(withLedgerAck({ assignments }, acknowledged))");
    expect(DRAWER.match(/apiFetch\(/g)?.length).toBe(2); // the read and the acknowledged write
  });
});

describe("cost basis beside Available is the available shares' basis", () => {
  it("prorates a partly used lot and leaves a whole lot alone", () => {
    // 400 acquired for 8,000 (20 a share); 100 still available.
    expect(availableCostBasis({ costBasis: 8000, quantityAcquired: 400, remainingAsOfDonationDate: 100 })).toBe(2000);
    expect(availableCostBasis({ costBasis: 8000, quantityAcquired: 400, remainingAsOfDonationDate: 400 })).toBe(8000);
    expect(availableCostBasis({ costBasis: 8000, quantityAcquired: 400, remainingAsOfDonationDate: 0 })).toBe(0);
  });

  it("has no figure for a lot with no acquired quantity", () => {
    expect(availableCostBasis({ costBasis: 8000, quantityAcquired: 0, remainingAsOfDonationDate: 0 })).toBeNull();
  });

  it("the row prints it through Money under an honest label", () => {
    expect(DRAWER).toContain("<Money value={availableCostBasis(lot)} />");
    expect(DRAWER).not.toContain("<Money value={lot.costBasis} />");
    const row = sliceBetween(DRAWER, "Available <Shares value={lot.remainingAsOfDonationDate}", "</span>");
    expect(row.replace(/\s+/g, " ")).toContain("Cost basis of available");
  });
});

describe("the close button is reachable by touch", () => {
  it("carries a pointer-coarse hit extension and no desktop change", () => {
    const button = DRAWER.slice(anchorIndex(DRAWER, "onClick={onClose}"), anchorIndex(DRAWER, 'aria-label="Close"'));
    expect(button).toContain("relative ");
    expect(button).toContain("pointer-coarse:after:absolute");
    expect(button).toContain("pointer-coarse:after:content-['']");
    expect(button).toContain("pointer-coarse:after:-inset-y-3");
    expect(button).toContain("pointer-coarse:after:-inset-x-4");
    // Every added class is touch-only apart from the positioning anchor.
    const added = button.match(/className="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    const others = added.filter((c) => !c.startsWith("pointer-coarse:"));
    expect(others.sort()).toEqual(["hover:text-ink", "relative", "shrink-0", "text-ink-faint", "text-sm"].sort());
  });
});

function gift(over: Partial<GivingDonation["donation"]> = {}, accountName: string | null = "Test Taxable"): GivingDonation {
  return {
    donation: {
      id: 1,
      source_key: "qa-b21-1",
      import_batch_id: null,
      kind: "stock",
      security_id: 1,
      symbol_raw: "ZZAA",
      quantity: 12.5,
      fmv_usd: 3000,
      unit_valuation: null,
      created_date: null,
      received_date: "2026-03-02",
      completed_date: null,
      reversed_date: null,
      notes: null,
      ...over,
    },
    accountName,
    basis: null,
    gainAvoided: null,
    basisImplausible: false,
    flaggedLots: [],
    longTermQuantity: null,
    shortTermQuantity: null,
    status: "received",
    needsLots: false,
    linked: true,
    symbolResolved: true,
  };
}

describe("a destructive confirm names one donation", () => {
  it("two gifts of one symbol get different names", () => {
    const a = donationConfirmName(gift());
    const b = donationConfirmName(gift({ id: 2, received_date: "2026-05-11" }));
    expect(a).toBe("the ZZAA donation received 2026-03-02");
    expect(b).toBe("the ZZAA donation received 2026-05-11");
    expect(donationConfirmName(gift({ kind: "cash", symbol_raw: null, quantity: null }))).toBe(
      "the cash gift received 2026-03-02"
    );
    expect(donationConfirmName(gift({ symbol_raw: null }))).toBe("the stock donation received 2026-03-02");
  });

  it("the identity line shows account, quantity and value, and hides the figures in privacy mode", () => {
    mockPrivate = false;
    const open = renderToStaticMarkup(<DonationIdentityLine gd={gift()} />);
    expect(open).toContain("Test Taxable");
    expect(open).toContain("12.5000");
    expect(open).toContain("$3,000");

    mockPrivate = true;
    const hidden = renderToStaticMarkup(<DonationIdentityLine gd={gift()} />);
    mockPrivate = false;
    expect(hidden).toContain("Test Taxable");
    expect(hidden).not.toContain("12.5");
    expect(hidden).not.toContain("3,000");

    const cash = renderToStaticMarkup(<DonationIdentityLine gd={gift({ kind: "cash", quantity: null }, null)} />);
    expect(cash).not.toContain("Qty");
    expect(cash).toContain("FMV");
  });

  it("both confirms use the name and the identity line; the drawer heading carries the date", () => {
    expect(SECTION).toContain("`Mark ${donationConfirmName(reverseTarget)} as reversed?");
    expect(SECTION).toContain("`Unlink the OUT leg of ${donationConfirmName(unlinkTarget)}?");
    expect(SECTION).toContain("{reverseTarget && <DonationIdentityLine gd={reverseTarget} />}");
    expect(SECTION).toContain("{unlinkTarget && <DonationIdentityLine gd={unlinkTarget} />}");
    expect(SECTION).not.toContain('symbol_raw ?? "this donation"');
    expect(SECTION).toContain("receivedDate={drawerDonation.donation.received_date}");
    expect(DRAWER).toContain("· received {receivedDate}");
  });

  it("the stock table keeps its scroll affordance", () => {
    const table = sliceBetween(SECTION, "{stockDonations.length > 0 && (", "{cashDonations.length > 0 && (");
    expect(anchorIndex(table, "<ScrollFade>")).toBeLessThan(anchorIndex(table, "<table"));
  });
});
