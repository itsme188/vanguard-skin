/**
 * BogeysUploadButton — with the route supplying the matched event's date and
 * symbol (TODO f11), the outcome line is exact: it names the print it matched
 * and says "not in the week shown" only from the server's date against the
 * week the hub shows. The on-screen-row guess stays only for a response that
 * carries no date. Pure functions; the wiring is pinned from source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  describeUploadOutcome,
  locateInShownWeek,
  placeByServerDate,
  type UploadResponse,
} from "@/app/dashboard/today/BogeysUploadButton";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const WEEK = "2026-08-31"; // Monday; the hub shows Aug 31 through Sep 6.
const SHOWN = [
  { id: 11, symbol: "AAA", eventDate: "2026-09-02" },
  { id: 12, symbol: "ZZZ", eventDate: "2026-09-03" },
];

const one = (r: NonNullable<UploadResponse["results"]>[number]): UploadResponse => ({
  symbolsExtracted: 1,
  eventsMatched: 1,
  results: [r],
});

/** The same two steps the button runs, in the same order. */
const text = (r: UploadResponse, shown: typeof SHOWN | undefined = SHOWN) =>
  describeUploadOutcome(locateInShownWeek(placeByServerDate(r, WEEK), shown), "sheet.pdf").map((l) => l.text);

describe("placeByServerDate — the week comes from the server's date", () => {
  it("a date inside the week shown is named and not called off-week", () => {
    expect(text(one({ symbol: "AAA", eventId: 11, bogeyId: 5, eventDate: "2026-09-02" }))).toEqual([
      "1/1 matched",
      "bogeys saved for AAA (Sep 2)",
    ]);
  });

  it("the first and last day of the week are inside it", () => {
    expect(text(one({ symbol: "AAA", eventId: 1, bogeyId: 5, eventDate: "2026-08-31" }))[1]).toBe(
      "bogeys saved for AAA (Aug 31)",
    );
    expect(text(one({ symbol: "AAA", eventId: 1, bogeyId: 5, eventDate: "2026-09-06" }))[1]).toBe(
      "bogeys saved for AAA (Sep 6)",
    );
  });

  it("a date after the week is called off-week, with the date", () => {
    expect(text(one({ symbol: "QQQQ", eventId: 99, bogeyId: 7, eventDate: "2026-09-07" }))).toEqual([
      "1/1 matched",
      "bogeys saved for QQQQ (Sep 7, not in the week shown)",
    ]);
  });

  it("a date before the week is called off-week too", () => {
    expect(text(one({ symbol: "QQQQ", eventId: 99, bogeyId: 7, eventDate: "2026-08-28" }))[1]).toBe(
      "bogeys saved for QQQQ (Aug 28, not in the week shown)",
    );
  });

  it("an in-week date is trusted even when the row is not among the rows handed in", () => {
    // The old guess looked for the row on screen and would have called this
    // off-week; the server's date settles it.
    expect(text(one({ symbol: "QQQQ", eventId: 99, bogeyId: 7, eventDate: "2026-09-04" }))[1]).toBe(
      "bogeys saved for QQQQ (Sep 4)",
    );
  });

  it("an off-week date is not rescued by a same-symbol row on screen", () => {
    expect(text(one({ symbol: "AAA", eventId: 99, bogeyId: 7, eventDate: "2026-09-08" }))[1]).toBe(
      "bogeys saved for AAA (Sep 8, not in the week shown)",
    );
  });

  it("names the sibling share class the event is filed under", () => {
    expect(
      text(one({ symbol: "GOOG", eventId: 11, bogeyId: 5, eventDate: "2026-09-02", eventSymbol: "GOOGL" })),
    ).toEqual(["1/1 matched", "bogeys saved for GOOG (matched GOOGL, Sep 2)"]);
  });

  it("a sibling off-week match names the symbol, the date and the week", () => {
    expect(
      text(one({ symbol: "GOOG", eventId: 99, bogeyId: 5, eventDate: "2026-09-08", eventSymbol: "GOOGL" }))[1],
    ).toBe("bogeys saved for GOOG (matched GOOGL, Sep 8, not in the week shown)");
  });

  it("with no date from the server the on-screen guess still runs, in its own words", () => {
    expect(text(one({ symbol: "AAA", eventId: 11, bogeyId: 5 }))[1]).toBe("bogeys saved for AAA (Sep 2)");
    expect(text(one({ symbol: "QQQQ", eventId: 99, bogeyId: 7 }))[1]).toBe(
      "bogeys saved for QQQQ (not in the week shown under that symbol)",
    );
    expect(text(one({ symbol: "QQQQ", eventId: 99, bogeyId: 7, eventDate: null }))[1]).toBe(
      "bogeys saved for QQQQ (not in the week shown under that symbol)",
    );
  });

  it("an unreadable date or week claims nothing about the week", () => {
    const bad = placeByServerDate(one({ symbol: "AAA", eventId: 11, bogeyId: 5, eventDate: "Sep 2" }), WEEK);
    expect(bad.results![0].offWeek).toBeUndefined();
    const noWeek = placeByServerDate(
      one({ symbol: "AAA", eventId: 11, bogeyId: 5, eventDate: "2026-09-08" }),
      "this week",
    );
    expect(noWeek.results![0].offWeek).toBeUndefined();
    // A dated result with no week verdict is left alone by the guess as well.
    expect(
      describeUploadOutcome(locateInShownWeek(noWeek, SHOWN), "sheet.pdf").map((l) => l.text)[1],
    ).toBe("bogeys saved for AAA (Sep 8)");
  });

  it("an unmatched symbol is never placed", () => {
    const out = placeByServerDate(
      { symbolsExtracted: 1, eventsMatched: 0, eventsUnmatched: ["QQQQ"], results: [{ symbol: "QQQQ", eventId: null }] },
      WEEK,
    );
    expect(out.results![0].offWeek).toBeUndefined();
  });

  it("a week that crosses a month end and a year end is counted by calendar days", () => {
    const inWeek = placeByServerDate(
      one({ symbol: "AAA", eventId: 1, bogeyId: 5, eventDate: "2027-01-03" }),
      "2026-12-28",
    );
    expect(inWeek.results![0].offWeek).toBe(false);
    const after = placeByServerDate(
      one({ symbol: "AAA", eventId: 1, bogeyId: 5, eventDate: "2027-01-04" }),
      "2026-12-28",
    );
    expect(after.results![0].offWeek).toBe(true);
  });
});

describe("BogeysUploadButton — wiring", () => {
  const src = readFileSync("app/dashboard/today/BogeysUploadButton.tsx", "utf8");

  it("places each match by the server's date before the on-screen guess", () => {
    const place = anchorIndex(src, "placeByServerDate(r.data, weekOf)");
    const guess = anchorIndex(src, "locateInShownWeek(data, shownEvents)");
    expect(place).toBeLessThan(guess);
  });

  it("reads the response through the shared mutation reader", () => {
    const start = anchorIndex(src, "async function handleFile(");
    const handler = src.slice(start, anchorIndex(src, "return (", start));
    expect(handler).toContain("readMutationResult<UploadResponse>(res)");
    expect(handler).toContain("networkFailureMessage(");
    expect(handler).not.toMatch(/if \(!res\.ok\)/);
    expect(handler).not.toContain("err.message");
  });
});
