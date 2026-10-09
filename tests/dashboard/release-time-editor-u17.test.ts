/**
 * Release-time editor (unit 17, 2026-10-08). No DOM harness: the pure helpers
 * are tested directly and the wiring is pinned against source with loud
 * anchors. Symbols and times are synthetic.
 *
 * qa:today-earningshub-release-time--clear-destroys-web-verified-regression-1
 * qa:today-earningshub-release-time--popover-contradicts-row-time-regression-1
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";
import {
  reportsAtTime,
  reportsAtSource,
  releaseTimeInputValue,
  releaseTimeAskFirst,
  standingNotUsedLine,
  standingNotAppliedLine,
  REPLACE_WEB_VERIFIED_CODE,
  type ReleaseTimeState,
} from "@/app/dashboard/today/EarningsDateChip";
import { WOULD_REPLACE_WEB_VERIFIED } from "@/lib/earnings/wire-times";

const DATE_CHIP = readFileSync("app/dashboard/today/EarningsDateChip.tsx", "utf8");

describe("the 'Reports at' line shows the row's own time", () => {
  const standingUser: ReleaseTimeState = {
    resolved: { time: "16:30", source: "user" },
    override: { source: "user", release_time: "16:30" },
    overrideUse: "in_effect",
  };

  it("a row that kept its own time is not shown the ticker's standing time", () => {
    // A reported row is not re-timed by a Save, so it still reads 16:05.
    expect(reportsAtTime(standingUser, "16:05")).toBe("16:05");
    // The source tag belongs to the standing time, so it is not shown here.
    expect(reportsAtSource(standingUser, "16:05")).toBeNull();
    expect(standingNotAppliedLine(standingUser, "16:05")).toBe(
      "The standing time 16:30 is not applied to this row.",
    );
  });

  it("when the row carries the standing time, the source tag shows and there is no extra line", () => {
    expect(reportsAtTime(standingUser, "16:30")).toBe("16:30");
    expect(reportsAtSource(standingUser, "16:30")).toBe("user");
    expect(standingNotAppliedLine(standingUser, "16:30")).toBeNull();
  });

  it("a row with no stored time falls back to the resolved time", () => {
    expect(reportsAtTime(standingUser, null)).toBe("16:30");
    expect(reportsAtSource(standingUser, null)).toBe("user");
    expect(reportsAtTime(null, null)).toBeNull();
    expect(standingNotAppliedLine(standingUser, null)).toBeNull();
  });

  it("an observed time is not called a standing time", () => {
    const observed: ReleaseTimeState = { resolved: { time: "16:00", source: "observed" }, override: null };
    expect(reportsAtTime(observed, "16:15")).toBe("16:15");
    expect(standingNotAppliedLine(observed, "16:15")).toBeNull();
  });

  it("the editor renders the helpers", () => {
    const editor = sliceBetween(DATE_CHIP, "function ReleaseTimeEditor(", "export function EarningsDateChip(");
    anchorIndex(editor, "reportsAtTime(rt, releaseTime)");
    anchorIndex(editor, "reportsAtSource(rt, releaseTime)");
    anchorIndex(editor, "standingNotUsedLine(rt)");
    anchorIndex(editor, "standingNotAppliedLine(rt, releaseTime)");
    expect(editor).not.toContain("rt.resolved.source");
  });
});

describe("a web-verified time the app does not use", () => {
  const suspect: ReleaseTimeState = {
    resolved: null,
    override: { source: "web_verified", release_time: "17:00" },
    overrideUse: "suspect_call_time",
  };
  const outranked: ReleaseTimeState = {
    resolved: { time: "16:00", source: "observed" },
    override: { source: "web_verified", release_time: "16:20" },
    overrideUse: "not_in_effect",
  };
  const used: ReleaseTimeState = {
    resolved: { time: "16:05", source: "web_verified" },
    override: { source: "web_verified", release_time: "16:05" },
    overrideUse: "in_effect",
  };

  it("never seeds the input: one Save must not turn a suspect call time into the user's time", () => {
    expect(releaseTimeInputValue(null, suspect, "16:15")).toBe("16:15");
    expect(releaseTimeInputValue(null, outranked, "16:00")).toBe("16:00");
    // A used standing time still seeds it.
    expect(releaseTimeInputValue(null, used, "16:05")).toBe("16:05");
    // What the user typed always wins.
    expect(releaseTimeInputValue("16:40", suspect, "16:15")).toBe("16:40");
  });

  it("says in plain words that the standing time is not used", () => {
    expect(standingNotUsedLine(suspect)).toBe(
      "Not used: 17:00 or later after the close is usually the call, not the release.",
    );
    expect(standingNotUsedLine(outranked)).toBe("Not used for this row.");
    expect(standingNotUsedLine(used)).toBeNull();
    expect(standingNotUsedLine(null)).toBeNull();
    expect(standingNotUsedLine({ resolved: null, override: null, overrideUse: null })).toBeNull();
  });
});

describe("Save over a web-verified time asks first", () => {
  it("the client and the server agree on the code", () => {
    expect(REPLACE_WEB_VERIFIED_CODE).toBe(WOULD_REPLACE_WEB_VERIFIED);
  });

  it("only a 409 with the named code and a message is a question", () => {
    const body = { success: false, code: "would_replace_web_verified", error: "ZZA has a web-verified time. Save anyway?" };
    expect(releaseTimeAskFirst(409, body)).toEqual({ message: "ZZA has a web-verified time. Save anyway?" });
    expect(releaseTimeAskFirst(409, { ...body, code: "slot_mismatch" })).toBeNull();
    expect(releaseTimeAskFirst(400, body)).toBeNull();
    expect(releaseTimeAskFirst(409, { ...body, error: "  " })).toBeNull();
    expect(releaseTimeAskFirst(409, null)).toBeNull();
    expect(releaseTimeAskFirst(409, "nope")).toBeNull();
  });

  it("the save sends the acknowledgement only after the question, and reads the reply through the shared reader", () => {
    const save = sliceBetween(DATE_CHIP, "async function saveReleaseTime(", "// Submitting the pre-filled form");
    anchorIndex(save, "replaceWebVerified: true");
    anchorIndex(save, "releaseTimeAskFirst(");
    anchorIndex(save, "setRtAsk(");
    anchorIndex(save, "readMutationResult");
    anchorIndex(save, "networkFailureMessage(");
    expect(save).not.toContain("body?.error");
    expect(save).not.toContain("res.ok");
  });

  it("the question is the app's ConfirmDialog, never a native confirm", () => {
    const editor = sliceBetween(DATE_CHIP, "function ReleaseTimeEditor(", "export function EarningsDateChip(");
    anchorIndex(editor, "<ConfirmDialog");
    anchorIndex(editor, 'confirmLabel="Save anyway"');
    expect(DATE_CHIP).not.toMatch(/window\.confirm\(|[^a-zA-Z.]confirm\("/);
    anchorIndex(DATE_CHIP, 'import { ConfirmDialog } from "../components/ConfirmDialog";');
  });

  it("Escape answers the question without also closing the popover", () => {
    const dismiss = sliceBetween(DATE_CHIP, "function handleKeyDown(e: KeyboardEvent)", "document.addEventListener(\"pointerdown\"");
    anchorIndex(dismiss, "rtAsk");
  });
});
