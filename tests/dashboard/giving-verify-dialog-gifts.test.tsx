/**
 * Giving (sprint 2026-10-08, unit 23):
 *
 *  1. the "Mark basis verified" dialog says the check is saved for the LOT
 *     and lists, by year, the gifts that one save changes;
 *  2. the lot drawer marks a lot whose basis is flagged for this gift and
 *     says how the suggestion treats it.
 *
 * The dialog is rendered to static markup from what the REAL view returns
 * for lots the REAL engine opened. There is no DOM harness in this repo, so
 * the drawer (which loads over the network) is covered by its exported
 * helpers and by source pins. Every figure here is invented.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getGivingView,
  getOpenLotsForDonation,
  type GivingFlaggedLot,
  type GivingLotGift,
} from "@/lib/queries/giving-view";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { assign, seedGift, seedSecurity, seedTxn } from "../helpers/giving-basis-fixture";

let mockPrivate = false;
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: mockPrivate, setPrivate: () => {}, toggle: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { BasisVerifiedDialog, giftsFedByYear } from "@/app/dashboard/components/giving/LotBasisControl";
import {
  DRAWER_BASIS_FLAG_LABEL,
  SUGGESTION_FLAGGED_NOTE,
  drawerBasisFlagLabel,
} from "@/app/dashboard/components/giving/LotAssignmentDrawer";

const CONTROL = readFileSync("app/dashboard/components/giving/LotBasisControl.tsx", "utf8");
const DRAWER = readFileSync("app/dashboard/components/giving/LotAssignmentDrawer.tsx", "utf8");

let db: Database.Database;

beforeEach(() => {
  mockPrivate = false;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function flaggedLot(donationId: number): GivingFlaggedLot {
  for (const y of getGivingView(db).years) {
    const found = y.donations.find((gd) => gd.donation.id === donationId);
    if (found) return found.flaggedLots[0];
  }
  throw new Error(`no donation ${donationId}`);
}

const dialog = (giftsFed: GivingLotGift[]) =>
  renderToStaticMarkup(
    <BasisVerifiedDialog
      open
      symbol="ZZBB"
      acquisitionDate="2010-01-10"
      giftsFed={giftsFed}
      note=""
      busy={false}
      error={null}
      onNoteChange={() => {}}
      onSave={() => {}}
      onCancel={() => {}}
    />
  );

/** One penny lot feeding four gifts: one in 2024, two in 2025, one in 2026. */
function seedSharedPennyLot() {
  const sec = seedSecurity(db, "ZZBB");
  const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
  const gifts = ["2024-03-01", "2025-03-03", "2025-09-02", "2026-03-02"].map((date) => {
    const id = seedGift(db, sec, date, 10, 1000);
    assign(db, id, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    return id;
  });
  return { sec, penny, gifts };
}

describe("giftsFedByYear", () => {
  it("counts the gifts per year, oldest year first", () => {
    expect(
      giftsFedByYear([
        { donationId: 3, receivedDate: "2025-09-02" },
        { donationId: 1, receivedDate: "2024-03-01" },
        { donationId: 2, receivedDate: "2025-03-03" },
      ])
    ).toEqual([
      { year: "2024", count: 1 },
      { year: "2025", count: 2 },
    ]);
    expect(giftsFedByYear([])).toEqual([]);
  });
});

describe("the verify dialog names the gifts one save changes", () => {
  it("a lot feeding four gifts: says it is per lot, how many gifts, and which years", () => {
    const { gifts } = seedSharedPennyLot();
    const lot = flaggedLot(gifts[3]);
    expect(lot.giftsFed).toHaveLength(4);
    const html = dialog(lot.giftsFed);

    expect(html).toContain("This check is saved for the lot, not for one gift.");
    expect(html).toMatch(/This lot feeds <span>4<\/span> gifts, and saving changes all of them:/);
    expect(html).toMatch(/<li>2024: <span>1<\/span> gift<\/li>/);
    expect(html).toMatch(/<li>2025: <span>2<\/span> gifts<\/li>/);
    expect(html).toMatch(/<li>2026: <span>1<\/span> gift<\/li>/);
    expect(html).toContain(
      "Each of them counts toward Gain avoided again, unless another of its lots is still flagged."
    );
    // The single-gift sentence would be wrong here.
    expect(html).not.toContain("The gift then counts toward Gain avoided again.");
    // What the dialog always said still stands.
    expect(html).toContain("ZZBB lot acquired 2010-01-10");
    expect(html).toContain("It changes no tax figure and does not recompute the ledger.");
  });

  it("a lot feeding one gift keeps the plain single-gift wording and shows no list", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, gift, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    const html = dialog(flaggedLot(gift).giftsFed);
    expect(html).toContain("The gift then counts toward Gain avoided again.");
    expect(html).not.toContain("This lot feeds");
    expect(html).not.toContain("<li>");
  });

  it("privacy mode masks every count and never lets the noun give away a single gift", () => {
    const { gifts } = seedSharedPennyLot();
    mockPrivate = true;
    const html = dialog(flaggedLot(gifts[0]).giftsFed);
    expect(html).toContain("This lot feeds");
    expect(html).not.toMatch(/<span>[0-9]+<\/span>/);
    expect(html).not.toMatch(/<\/span> gift<\/li>/);
    expect(html).toMatch(/<li>2024: <span>[^<0-9]+<\/span> gifts<\/li>/);
  });

  it("the control hands the dialog the lot's own list, and counts go through <Count>", () => {
    const wiring = sliceBetween(CONTROL, "<BasisVerifiedDialog", "/>");
    expect(wiring).toContain("giftsFed={lot.giftsFed}");
    const list = CONTROL.slice(anchorIndex(CONTROL, "function GiftsFedNote("));
    expect(list).toContain("<Count value={gifts.length} />");
    expect(list).toContain("<Count value={count} />");
  });
});

describe("the lot drawer marks a flagged lot and explains the suggestion", () => {
  it("labels the two flagged states in plain words and nothing else", () => {
    expect(DRAWER_BASIS_FLAG_LABEL).toEqual({
      implausible: "basis implausible",
      "verified-stale": "basis changed since verified",
    });
    expect(drawerBasisFlagLabel("implausible")).toBe("basis implausible");
    expect(drawerBasisFlagLabel("verified-stale")).toBe("basis changed since verified");
    expect(drawerBasisFlagLabel("plausible")).toBeNull();
    // A lot the owner verified reads like any other lot in the drawer.
    expect(drawerBasisFlagLabel("verified")).toBeNull();
  });

  it("the label follows the state the real query returns for an engine-built lot", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const ordinary = seedTxn(db, sec, "2015-01-12", "BUY", 100, 40);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);
    const labels = new Map(
      getOpenLotsForDonation(db, gift).map((l) => [l.acquisitionTransactionId, drawerBasisFlagLabel(l.basisState)])
    );
    expect(labels.get(penny)).toBe("basis implausible");
    expect(labels.get(ordinary)).toBeNull();
  });

  it("draws a warn chip from the served state and shows the note only when a lot is flagged", () => {
    expect(DRAWER).toContain("const basisFlag = drawerBasisFlagLabel(lot.basisState);");
    expect(DRAWER).toMatch(/\{basisFlag != null && \(\s*<Chip tone="warn" size="xs">\s*\{basisFlag\}\s*<\/Chip>\s*\)\}/);
    expect(DRAWER).toContain("const anyFlagged = (lots ?? []).some((lot) => drawerBasisFlagLabel(lot.basisState) != null);");
    expect(DRAWER).toMatch(/\{anyFlagged && <p className="text-xs text-ink-dim mb-2">\{SUGGESTION_FLAGGED_NOTE\}<\/p>\}/);
    expect(SUGGESTION_FLAGGED_NOTE).toContain("last");
    expect(SUGGESTION_FLAGGED_NOTE).toContain("cannot cover the gift");
  });

  it("the suggestion is still applied from the served flags, never re-ranked in the browser", () => {
    const body = sliceBetween(DRAWER, "function applySuggestion()", "function submit(");
    expect(body).toContain("if (!lot.suggested) continue;");
    expect(body).not.toContain("basisState");
    expect(body).not.toContain(".sort(");
  });
});
