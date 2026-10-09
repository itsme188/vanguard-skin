/**
 * The Recompute preview's open-lot count was higher than the Open Lots
 * table's row count with no reason given: the preview counts every open lot
 * in every account, and the page lists expired option lots and
 * currency-conversion lots apart from that table. This line says so.
 *
 * No DOM harness in this repo: `renderToStaticMarkup` with `usePrivacy`
 * mocked off a mutable flag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecomputeOpenLotScope } from "@/app/dashboard/components/RecomputeOpenLotScope";

const privacyState = vi.hoisted(() => ({ isPrivate: false }));
vi.mock("@/lib/privacy/context", () => ({
  usePrivacy: () => ({ isPrivate: privacyState.isPrivate, setPrivate: () => {}, toggle: () => {} }),
  PrivacyProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const MASK = "•••";

beforeEach(() => {
  privacyState.isPrivate = false;
});

describe("RecomputeOpenLotScope", () => {
  it("always says the count covers every account", () => {
    const html = renderToStaticMarkup(
      <RecomputeOpenLotScope
        breakdown={{
          expiredOptionLots: { before: 0, after: 0 },
          currencyConversionLots: { before: 0, after: 0 },
        }}
      />
    );
    expect(html).toContain("Counts every open lot in every account");
    expect(html).not.toContain("Includes");
    expect(html).not.toContain("fewer rows");
  });

  it("names the expired option lots and the currency-conversion lots it includes", () => {
    const html = renderToStaticMarkup(
      <RecomputeOpenLotScope
        breakdown={{
          expiredOptionLots: { before: 2, after: 3 },
          currencyConversionLots: { before: 4, after: 4 },
        }}
      />
    );
    expect(html).toContain(
      "Includes expired option lots awaiting a closing entry: <span>2</span> → <span>3</span>"
    );
    expect(html).toContain("Includes currency-conversion lots: <span>4</span> → <span>4</span>");
    expect(html).toContain("The Open Lots table lists those apart, so it shows fewer rows.");
  });

  it("shows only the kind that is present", () => {
    const html = renderToStaticMarkup(
      <RecomputeOpenLotScope
        breakdown={{
          expiredOptionLots: { before: 0, after: 1 },
          currencyConversionLots: { before: 0, after: 0 },
        }}
      />
    );
    expect(html).toContain("expired option lots");
    expect(html).not.toContain("currency-conversion");
  });

  it("masks every count under Hide amounts, and the nouns do not change with the count", () => {
    privacyState.isPrivate = true;
    const one = renderToStaticMarkup(
      <RecomputeOpenLotScope
        breakdown={{
          expiredOptionLots: { before: 1, after: 1 },
          currencyConversionLots: { before: 1, after: 1 },
        }}
      />
    );
    const many = renderToStaticMarkup(
      <RecomputeOpenLotScope
        breakdown={{
          expiredOptionLots: { before: 5, after: 7 },
          currencyConversionLots: { before: 3, after: 2 },
        }}
      />
    );
    expect(one).toBe(many);
    expect(one).toContain(`<span>${MASK}</span>`);
    expect(one).not.toMatch(/\d/);
  });

  it("still renders the scope sentence when the server sent no breakdown", () => {
    const html = renderToStaticMarkup(<RecomputeOpenLotScope />);
    expect(html).toContain("Counts every open lot in every account");
    expect(html).not.toContain("Includes");
  });
});
