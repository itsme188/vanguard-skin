/**
 * Today surface, empty-state honesty (qa: upload match-success-unnamed-off-
 * week-invisible, next-releases shows 4 of N with no "more" cue). No DOM
 * harness in this repo: the wording and the count are pure functions, the
 * wiring is pinned from source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeUploadOutcome, locateInShownWeek } from "@/app/dashboard/today/BogeysUploadButton";
import { hiddenReleaseCount } from "@/app/dashboard/components/TodayReleases";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const SHOWN = [
  { id: 11, symbol: "AAA", eventDate: "2026-09-02" },
  { id: 12, symbol: "ZZZ", eventDate: "2026-09-03" },
];

const text = (r: Parameters<typeof describeUploadOutcome>[0]) =>
  describeUploadOutcome(locateInShownWeek(r, SHOWN), "sheet.pdf").map((l) => l.text);

describe("describeUploadOutcome — names where a match landed", () => {
  it("gives a matched row on screen its own date from the rows shown", () => {
    expect(
      text({ symbolsExtracted: 1, eventsMatched: 1, results: [{ symbol: "AAA", eventId: 11, bogeyId: 5 }] }),
    ).toEqual(["1/1 matched", "bogeys saved for AAA (Sep 2)"]);
  });

  it("says so when the matched event is not in the week shown", () => {
    expect(
      text({ symbolsExtracted: 1, eventsMatched: 1, results: [{ symbol: "QQQQ", eventId: 99, bogeyId: 7 }] }),
    ).toEqual([
      "1/1 matched",
      "bogeys saved for QQQQ (not in the week shown under that symbol)",
    ]);
  });

  it("names the off-week date too when the route supplies it", () => {
    expect(
      text({
        symbolsExtracted: 1,
        eventsMatched: 1,
        results: [{ symbol: "QQQQ", eventId: 99, bogeyId: 7, eventDate: "2026-09-07" }],
      }),
    ).toEqual(["1/1 matched", "bogeys saved for QQQQ (Sep 7, not in the week shown under that symbol)"]);
  });

  it("a row shown under another id but the same symbol is not called off-week", () => {
    expect(
      text({ symbolsExtracted: 1, eventsMatched: 1, results: [{ symbol: "zzz", eventId: 77, bogeyId: 5 }] }),
    ).toEqual(["1/1 matched", "bogeys saved for zzz (Sep 3)"]);
  });

  it("without the rows shown it claims nothing about the week", () => {
    expect(
      describeUploadOutcome(
        locateInShownWeek(
          { symbolsExtracted: 1, eventsMatched: 1, results: [{ symbol: "QQQQ", eventId: 99, bogeyId: 7 }] },
          undefined,
        ),
        "sheet.pdf",
      ).map((l) => l.text),
    ).toEqual(["1/1 matched", "bogeys saved for QQQQ"]);
  });

  it("an unmatched symbol is never called off-week", () => {
    const out = locateInShownWeek(
      { symbolsExtracted: 1, eventsMatched: 0, eventsUnmatched: ["QQQQ"], results: [{ symbol: "QQQQ", eventId: null }] },
      SHOWN,
    );
    expect(out.results![0].offWeek).toBeUndefined();
  });

  it("the hub hands the button the rows it shows", () => {
    const hub = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");
    const i = anchorIndex(hub, "<BogeysUploadButton");
    expect(hub.slice(i, i + 260)).toContain("shownEvents=");
    const btn = readFileSync("app/dashboard/today/BogeysUploadButton.tsx", "utf8");
    expect(btn).toContain("setResult({ data: locateInShownWeek(data, shownEvents), fileName: file.name })");
  });
});

describe("hiddenReleaseCount — the '+N more' figure", () => {
  it("is exactly the rows not shown", () => {
    expect(hiddenReleaseCount(5, 4)).toBe(1);
    expect(hiddenReleaseCount(12, 4)).toBe(8);
  });

  it("is zero when everything is shown, or the total is unknown or nonsense", () => {
    expect(hiddenReleaseCount(4, 4)).toBe(0);
    expect(hiddenReleaseCount(3, 4)).toBe(0);
    expect(hiddenReleaseCount(undefined, 4)).toBe(0);
    expect(hiddenReleaseCount(null, 4)).toBe(0);
    expect(hiddenReleaseCount(Number.NaN, 4)).toBe(0);
    expect(hiddenReleaseCount(5.5, 4)).toBe(0);
  });

  it("the block renders it as a link, counted from the rows it actually lists", () => {
    const src = readFileSync("app/dashboard/components/TodayReleases.tsx", "utf8");
    expect(src).toContain("hiddenReleaseCount(totalCount, releases.length)");
    const i = anchorIndex(src, "{hidden > 0 && (");
    const block = src.slice(i, i + 700);
    expect(block).toContain("<Link");
    expect(block).toContain('href="/dashboard/calendar"');
    expect(block).toContain("+{hidden} more");
    // Tappable: no hover-only reveal on the row.
    expect(block).not.toMatch(/opacity-0|group-hover/);
  });
});
