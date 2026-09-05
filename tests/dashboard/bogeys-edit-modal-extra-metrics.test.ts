/**
 * Slice F, Task 4 — the bogeys modal's "Extra metrics" editor.
 *
 * The modal portals into `document.body`, and React Testing Library / jsdom are
 * NOT dependencies of this project (and none may be added), so the wiring is
 * pinned by reading the source and the numeric behaviour is proved through the
 * SAME pure parser the modal and the route both call.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseExtraMetrics } from "@/lib/print-watch/extra-metrics";

const src = readFileSync("app/dashboard/today/BogeysEditModal.tsx", "utf8");

describe("BogeysEditModal — extra metrics editor", () => {
  it("mints the id client-side with crypto.randomUUID and never lets the user edit it", () => {
    expect(src).toMatch(/crypto\.randomUUID\(\)/);
    expect(src).toMatch(/readOnly/);
  });
  it("validates with the SAME parser the route validates with, before POSTing", () => {
    expect(src).toMatch(/from "@\/lib\/print-watch\/extra-metrics"/);
    expect(src).toMatch(/parseExtraMetrics\(/);
  });
  it("sends extra_metrics_json in the save body", () => {
    expect(src).toMatch(/extra_metrics_json/);
  });
  it("renders a conflict banner from the GET response rather than inventing one", () => {
    expect(src).toMatch(/extraMetricConflicts/);
    expect(src).toMatch(/disagree on/);
  });
  it("checks res.ok AND the error field and never swallows a failure", () => {
    expect(src).not.toMatch(/catch\s*\{\s*\}/);
  });
  it("offers no caret affordance for the add/remove controls (project UI rule)", () => {
    expect(src).not.toMatch(/▾|▼/);
  });
});

describe("BogeysEditModal — id identity and the shared parser (Codex round 1)", () => {
  it("hydrates stored specs instead of re-minting their ids", () => {
    expect(src).toMatch(/extraMetrics/);
    expect(src).toMatch(/hydratedLabelRef/);
  });
  it("offers copy-id and accepts a pasted id at ADD time only (the id input stays readOnly)", () => {
    expect(src).toMatch(/copy id/);
    expect(src).toMatch(/isUuidV4\(/);
    expect(src).toMatch(/readOnly/);
  });
  it("checks the envelope's success flag, not just res.ok", () => {
    expect(src).toMatch(/data\??\.success/);
  });
  it("says something honest when the clipboard is refused", () => {
    expect(src).toMatch(/copy it by hand/);
  });
});

/**
 * Review M-6: a whole-file `not.toMatch(/parseLargeUSD\(r\./)` was trivially
 * evaded — the modal legitimately imports parseLargeUSD for the revenue fields,
 * so `parseLargeUSD(row.consensus)` or a local alias would have passed it. Pin
 * the serialiser's OWN slice instead, the way tests/print-watch/recompile.test.ts
 * slices recompileContracts.
 */
describe("extraRowsToJson coerces nothing — the shared parser reads each unit", () => {
  const OPEN = "function extraRowsToJson(";
  const CLOSE = "const plural =";
  const serialiser = src.slice(src.indexOf(OPEN), src.indexOf(CLOSE));

  it("slices the real function, not the rest of the file (anchor guard)", () => {
    expect(src.indexOf(OPEN), "the serialiser was renamed").toBeGreaterThan(-1);
    expect(src.indexOf(CLOSE), "the closing anchor moved above the serialiser").toBeGreaterThan(
      src.indexOf(OPEN),
    );
    expect(serialiser).toMatch(/JSON\.stringify\(/);
    expect(serialiser.length).toBeLessThan(src.length / 2);
  });

  it("holds no number parser at all: no parseLargeUSD, no Number(), no percent coercion", () => {
    expect(serialiser).not.toMatch(/parseLargeUSD/);
    expect(serialiser).not.toMatch(/\bNumber\s*\(/);
    expect(serialiser).not.toMatch(/parseFloat|parseInt|coercePercent/);
  });

  it("ships each row's own trimmed string, or null where the desk left it blank", () => {
    expect(serialiser).toMatch(
      /consensus: r\.consensus\.trim\(\) === "" \? null : r\.consensus\.trim\(\)/,
    );
    expect(serialiser).toMatch(
      /whisper: r\.whisper\.trim\(\) === "" \? null : r\.whisper\.trim\(\)/,
    );
  });
});

/** Fix round 1 — the modal has to SAY what it did (reviews I-1, I-2, M-1..M-4). */
describe("BogeysEditModal — honest feedback", () => {
  const between = (open: string, close: string) => {
    expect(src.indexOf(open), `${open} vanished`).toBeGreaterThan(-1);
    expect(src.indexOf(close), `${close} moved above ${open}`).toBeGreaterThan(src.indexOf(open));
    return src.slice(src.indexOf(open), src.indexOf(close));
  };
  const save = between("async function save(", "async function submitActuals(");

  it("renders a stored row's parse errors instead of an editor that only looks empty (I-1)", () => {
    expect(src).toMatch(/hydrationErrors\.map\(/);
    expect(src).toMatch(/stored extra metrics could not be read/);
  });

  it("refuses the save while those errors stand, with a deliberate way out (I-1)", () => {
    expect(save).toMatch(/hydrationErrors\.length > 0 && !discardUnreadable/);
    expect(save).toMatch(/would erase them/);
    expect(src).toMatch(/discard the unreadable metrics/);
    // The refusal comes BEFORE the POST, so nothing is written.
    expect(save.indexOf("!discardUnreadable")).toBeLessThan(save.indexOf("apiFetch("));
  });

  it("consumes the POST's recompile report rather than discarding it (I-2)", () => {
    expect(save).toMatch(/data\.recompiled/);
    expect(save).toMatch(/describeRecompile\(/);
    expect(save).toMatch(/needsAcknowledgement\(recompiled\)/);
    // …and that branch RETURNS before onClose(), so the modal cannot close on
    // an outcome the desk has not seen.
    const tail = save.slice(save.indexOf("const recompiled = data.recompiled;"));
    expect(tail.indexOf("return;")).toBeGreaterThan(-1);
    expect(tail.indexOf("return;")).toBeLessThan(tail.indexOf("onClose();"));
  });

  it("will not close on a retirement, a removal, a conflict or a sheet that did not move (I-2)", () => {
    const rule = between("function needsAcknowledgement(", "/** What GET /api/earnings/bogeys");
    expect(rule).toMatch(/report\.conflicts\.length > 0/);
    expect(rule).toMatch(/report\.retired\.length > 0/);
    expect(rule).toMatch(/report\.deleted\.length > 0/);
    expect(rule).toMatch(/report\.added\.length \+ report\.updated\.length === 0/);
  });

  it("names a retirement and a blocked line for what they are (I-2)", () => {
    expect(src).toMatch(/no longer measured under the old definition/);
    expect(src).toMatch(/until every sheet agrees on it/);
  });

  it("says so when a pasted id was not a full uuid instead of failing open (M-2)", () => {
    const add = between("function addExtraRow(", "async function copyId(");
    expect(add).toMatch(/is not a full v4 uuid/);
    expect(add).toMatch(/setExtraErrors\(/);
  });

  it("keeps a clipboard failure out of the parser's validation list (M-3)", () => {
    const copy = between("async function copyId(", "// Print the deterministic desk worksheet");
    expect(copy).not.toMatch(/setExtraErrors/);
    expect(copy).toMatch(/setCopyFailedId\(id\)/);
    expect(src).toMatch(/copyFailedId === row\.id/);
  });

  it("lets the 'copied' acknowledgement expire, and clears the timer (M-4)", () => {
    expect(src).toMatch(/setTimeout\(\(\) => setCopiedId\(null\), 2000\)/);
    expect(src).toMatch(/clearTimeout\(copyTimerRef\.current\)/);
  });

  it("keeps rows the desk typed when a label's stored metrics load (M-1)", () => {
    expect(src).toMatch(/const kept = extraRows\.filter\(\(r\) => !storedIds\.has\(r\.id\)\)/);
    expect(src).toMatch(/setHydrationNote\(/);
  });
});

describe("the editor's rows round-trip through the shared parser", () => {
  it("an editor row with empty numbers parses to nulls, not NaN", () => {
    const json = JSON.stringify([{
      id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
      unit: "usd", kind: "point", period: "Q", basis: "na", consensus: "", whisper: "",
    }]);
    expect(parseExtraMetrics(json)).toEqual({
      specs: [{
        id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Net new ARR", definition: "",
        unit: "usd", kind: "point", period: "Q", basis: "na", consensus: null, whisper: null,
      }],
      errors: [],
    });
  });

  it("a pct row's typed '27.5%' survives the editor unparsed and reads as 27.5", () => {
    // The defect the amendment fixed: the modal used to run parseLargeUSD over
    // EVERY unit, so a percent row was stored as "no bogey" instead of 27.5.
    const json = JSON.stringify([{
      id: "5b7a1f42-9c3e-4d18-8f6a-2e0b91c7d4a3", label: "Op margin", definition: "",
      unit: "pct", kind: "point", period: "Q", basis: "non_gaap", consensus: "27.5%", whisper: "",
    }]);
    const { specs, errors } = parseExtraMetrics(json);
    expect(errors).toEqual([]);
    expect(specs[0].consensus).toBe(27.5);
  });
});
