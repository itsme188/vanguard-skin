import { describe, it, expect } from "vitest";
import { notesListIsFiltered } from "@/app/dashboard/components/NotesView";

// The flag picks the empty-state copy ("No matching notes — clear the
// filter" vs "No notes yet"), so it must key on EXACTLY the params the
// server filtered by: ?search= and ?security= / ?security_id=.
//
// ?symbol= is the add-note prefill (it preselects the security dropdown and
// filters nothing), and ?type= is tab navigation. Keying on ?symbol= got it
// wrong in both directions: a search that filtered the earnings timeline to
// empty claimed "no earnings notes yet", while landing from a Security page
// with only ?symbol= claimed a filter was active that there was nothing to
// clear.
describe("notesListIsFiltered (empty-state copy selector)", () => {
  it("a bare tab selection (?type=) is navigation, not a user filter", () => {
    expect(notesListIsFiltered({ search: null, security: null, type: "trade_thesis" })).toBe(
      false,
    );
  });

  it("search counts as a user filter", () => {
    expect(notesListIsFiltered({ search: "NVDA", security: null, type: null })).toBe(true);
  });

  it("a whitespace-only search is not a filter", () => {
    expect(notesListIsFiltered({ search: "   ", security: null, type: null })).toBe(false);
  });

  it("the security filter counts, including combined with a tab", () => {
    expect(notesListIsFiltered({ search: null, security: "42", type: "earnings" })).toBe(
      true,
    );
    expect(notesListIsFiltered({ search: null, security: 42, type: null })).toBe(true);
  });

  it("?symbol= alone is an add-note prefill, not a filter", () => {
    // The Security-detail "+ Add note" link lands here with ?symbol=AAPL and
    // no ?security= — nothing is filtered, so an empty list means "no notes
    // yet", not "your filter matched nothing".
    expect(
      notesListIsFiltered({
        search: null,
        security: null,
        type: "trade_thesis",
        // @ts-expect-error — ?symbol= must not be part of the filter contract
        symbol: "AAPL",
      }),
    ).toBe(false);
  });

  it("a non-numeric ?security= does not filter (the server parseInt drops it)", () => {
    expect(notesListIsFiltered({ search: null, security: "NVDA", type: null })).toBe(false);
  });

  it("nothing set → not filtered", () => {
    expect(notesListIsFiltered({ search: null, security: null, type: null })).toBe(false);
  });
});
