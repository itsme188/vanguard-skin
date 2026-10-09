/**
 * Element ids on the Giving page are unique and built from stable data
 * (browser pass 2026-10-09).
 *
 * Two faults:
 *  1. `id="giving-reverse-date"` was written once per year section, so two
 *     sections put the same id in the page and a label could point at the
 *     other section's input.
 *  2. BasisVerifiedDialog took its label / input / hint ids from `useId`,
 *     and the page logged an intermittent hydration mismatch on exactly
 *     those values. The ids now come from the donation id plus the lot's
 *     acquisition transaction id, so server and client always agree.
 *
 * Everything is synthetic: ZZ* tickers and round invented numbers.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView } from "@/lib/queries/giving-view";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import { assign, seedFlaggedGift, seedGift } from "../helpers/giving-basis-fixture";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
}));
vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: false, setPrivate: () => {}, toggle: () => {} }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

import { lotBasisFieldIds, reverseDateInputId } from "@/app/dashboard/components/giving/giving-ids";
import { BasisVerifiedDialog } from "@/app/dashboard/components/giving/LotBasisControl";
import { GivingYearSection } from "@/app/dashboard/components/giving/GivingYearSection";

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
});

const idsIn = (html: string) => [...html.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
const duplicates = (ids: string[]) => [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

describe("the id helpers", () => {
  it("the reversed-date id carries the year", () => {
    expect(reverseDateInputId("2025")).toBe("giving-reverse-date-2025");
    expect(reverseDateInputId("2026")).not.toBe(reverseDateInputId("2025"));
  });

  it("the basis dialog ids carry the donation and the lot, and differ from each other", () => {
    expect(lotBasisFieldIds(7, 31)).toEqual({
      input: "lot-basis-source-d7-t31",
      hint: "lot-basis-hint-d7-t31",
    });
  });

  it("one lot under two gifts, and two lots under one gift, never share an id", () => {
    const all = [lotBasisFieldIds(7, 31), lotBasisFieldIds(8, 31), lotBasisFieldIds(7, 32)].flatMap((f) => [
      f.input,
      f.hint,
    ]);
    expect(new Set(all).size).toBe(6);
    // The separators keep (1, 23) apart from (12, 3).
    expect(lotBasisFieldIds(1, 23).input).not.toBe(lotBasisFieldIds(12, 3).input);
  });
});

describe("BasisVerifiedDialog", () => {
  const dialog = () =>
    renderToStaticMarkup(
      <BasisVerifiedDialog
        open
        fieldIds={lotBasisFieldIds(7, 31)}
        symbol="ZZBB"
        acquisitionDate="2010-01-10"
        giftsFed={[]}
        note=""
        busy={false}
        error={null}
        onNoteChange={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
      />
    );

  it("label, input and hint use the ids it is handed", () => {
    const html = dialog();
    expect(html).toContain('<label for="lot-basis-source-d7-t31"');
    expect(html).toContain('<input id="lot-basis-source-d7-t31"');
    expect(html).toContain('aria-describedby="lot-basis-hint-d7-t31"');
    expect(html).toContain('<p id="lot-basis-hint-d7-t31"');
  });

  it("renders the same markup every time (nothing generated)", () => {
    expect(dialog()).toBe(dialog());
  });
});

describe("a Giving page with two year sections", () => {
  /** One penny lot feeding a gift in each of two years, so both sections show a basis control. */
  function seedTwoYears() {
    const first = seedFlaggedGift(hoisted.db, "ZZBB", "2025-04-02");
    const second = seedGift(hoisted.db, first.sec, "2026-04-02", 10, 1000);
    assign(hoisted.db, second, [{ acquisitionTransactionId: first.lotTxn, quantity: 10 }]);
    return { lotTxn: first.lotTxn, donations: [first.donationId, second] };
  }

  const page = () =>
    getGivingView(hoisted.db)
      .years.map((y) => renderToStaticMarkup(<GivingYearSection year={y} />))
      .join("");

  it("no id appears twice", () => {
    const seeded = seedTwoYears();
    const years = getGivingView(hoisted.db).years;
    expect(years.map((y) => y.year).sort()).toEqual(["2025", "2026"]);
    const ids = idsIn(page());
    expect(duplicates(ids)).toEqual([]);
    // The bound: both sections really do render the fields in question.
    expect(ids).toContain("giving-reverse-date-2025");
    expect(ids).toContain("giving-reverse-date-2026");
    for (const donationId of seeded.donations) {
      expect(ids).toContain(lotBasisFieldIds(donationId, seeded.lotTxn).input);
    }
    expect(ids).not.toContain("giving-reverse-date");
  });

  it("every label points at an id that exists exactly once", () => {
    seedTwoYears();
    const html = page();
    const ids = idsIn(html);
    const targets = [...html.matchAll(/<label for="([^"]*)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets) {
      expect(ids.filter((id) => id === target), target).toHaveLength(1);
    }
  });

  it("two renders of the same data are byte-identical", () => {
    seedTwoYears();
    expect(page()).toBe(page());
  });
});

describe("how the ids are written", () => {
  const GIVING = "app/dashboard/components/giving";
  const read = (file: string) => readFileSync(`${GIVING}/${file}`, "utf8");

  it("LotBasisControl no longer calls useId", () => {
    const src = read("LotBasisControl.tsx");
    expect(src).not.toMatch(/\buseId\b/);
    const wiring = sliceBetween(src, "<BasisVerifiedDialog", "/>");
    expect(wiring).toContain("fieldIds={lotBasisFieldIds(donationId, lot.acquisitionTransactionId)}");
  });

  it("GivingYearSection passes the donation id and builds the reversed-date id from the year", () => {
    const src = read("GivingYearSection.tsx");
    const control = sliceBetween(src, "<LotBasisControl", "/>");
    expect(control).toContain("donationId={d.id}");
    expect(src).not.toContain('"giving-reverse-date"');
    const field = src.slice(anchorIndex(src, "Reversed date") - 200, anchorIndex(src, 'type="date"'));
    expect(field).toContain("htmlFor={reverseDateId}");
    expect(field).toContain("id={reverseDateId}");
    expect(src).toContain("const reverseDateId = reverseDateInputId(year.year);");
  });

  it("the id helpers use no random or clock value", () => {
    const src = read("giving-ids.ts");
    expect(src).not.toMatch(/Math\.random|Date\b|useId|crypto/);
  });
});
