/**
 * QA finding charts-last-viewed--only-picker-changes-recorded-not-link-or-
 * cmdk-arrivals (ruling 2026-09-11, "last viewed first"): the last-viewed
 * symbol is recorded on ANY arrival at a chart — a symbol link, a ticker
 * jump, the picker — not only from the picker's onChange.
 *
 * No DOM harness in this repo: the request classifier is a pure function
 * tested directly, and the page/view wiring is source-pinned.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { classifyChartRequest } from "@/app/dashboard/charts/last-symbol";

const pageSrc = () => readFileSync("app/dashboard/charts/page.tsx", "utf8");
const viewSrc = () =>
  readFileSync("app/dashboard/components/ChartsView.tsx", "utf8");

describe("classifyChartRequest", () => {
  const chartable = [11, 22, 33];

  it("a bare visit (no ?id=) is not a request", () => {
    expect(classifyChartRequest(undefined, chartable)).toEqual({ kind: "none" });
  });

  it("a blank ?id= is not a request either", () => {
    expect(classifyChartRequest("", chartable)).toEqual({ kind: "none" });
  });

  it("an id on the chartable list is a chartable arrival", () => {
    expect(classifyChartRequest("22", chartable)).toEqual({
      kind: "chartable",
      id: 22,
    });
  });

  it("a numeric id that is not chartable is unavailable, keeping the id", () => {
    expect(classifyChartRequest("99", chartable)).toEqual({
      kind: "unavailable",
      id: 99,
    });
  });

  it("a non-numeric or non-positive id is unavailable with no id", () => {
    expect(classifyChartRequest("abc", chartable)).toEqual({
      kind: "unavailable",
      id: null,
    });
    expect(classifyChartRequest("0", chartable)).toEqual({
      kind: "unavailable",
      id: null,
    });
    expect(classifyChartRequest("-5", chartable)).toEqual({
      kind: "unavailable",
      id: null,
    });
  });
});

describe("charts page records the arrival, however the user got there", () => {
  it("page.tsx passes the chartable arrival id down, and null otherwise", () => {
    const src = pageSrc();
    expect(src).toContain("classifyChartRequest(");
    expect(src).toMatch(
      /arrivedSecurityId=\{\s*request\.kind === "chartable" \? request\.id : null\s*\}/,
    );
  });

  it("ChartsView writes the last-viewed id in an effect keyed on the arrival id", () => {
    const src = viewSrc();
    const start = anchorIndex(src, "// Record the arrival");
    const end = anchorIndex(src, "}, [arrivedSecurityId]);", start);
    const body = src.slice(start, end);
    expect(body).toContain("useEffect(() => {");
    expect(body).toContain("if (arrivedSecurityId == null) return;");
    expect(body).toContain("writeLastChartSymbolId(arrivedSecurityId);");
  });

  it("the picker handler still records too (a pick before the URL round-trips)", () => {
    const src = viewSrc();
    const at = anchorIndex(src, "const handleSelect =");
    expect(src.slice(at, at + 400)).toContain("writeLastChartSymbolId(secId);");
  });

  it("the recording effect comes AFTER the mount restore, so a bare visit reads before anything writes", () => {
    const src = viewSrc();
    const restore = anchorIndex(src, "readLastChartSymbolId()");
    const record = anchorIndex(src, "// Record the arrival");
    expect(record).toBeGreaterThan(restore);
  });
});
