/**
 * QA 2026-09-15 — notes-ambient--save-failure-prints-raw-failed-to-fetch.
 *
 * The global Cmd+; NotesAmbient overlay (`handleSaveToNotes`) printed the
 * browser's raw exception text — "Failed to fetch" — in its footer status
 * line (where the "⌘; toggle · Esc close" hint normally sits) whenever the
 * POST /api/notes died at the network level. A 5xx body's raw exception text
 * could leak the same way through `throw new Error(data.error || ...)` off
 * an unchecked `res.ok`. The draft was always preserved (in the textarea and
 * in localStorage) — only the copy leaked.
 *
 * This mirrors the fix already landed for the Notes composer 2026-09-07
 * (research-notes-composer--raw-failed-to-fetch-error-text,
 * tests/dashboard/notes-composer-save-failure-copy.test.ts): route every
 * failure through the shared `describeNoteSaveFailure` helper
 * (`lib/notes/save-failure-copy.ts`, re-exported from NotesView.tsx for the
 * composer's existing imports) instead of reading `err.message` or throwing
 * a raw `Error`.
 *
 * This repo has no jsdom/RTL harness (see
 * tests/dashboard/narrative-block-refresh.test.ts) — following the
 * notesListIsFiltered / describeNoteSaveFailure precedent, this pins the
 * extracted handler's SOURCE rather than rendering the component.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeNoteSaveFailure } from "@/lib/notes/save-failure-copy";

const src = readFileSync("app/dashboard/components/NotesAmbient.tsx", "utf8");

function extractHandleSaveToNotes(): string {
  const start = src.indexOf("const handleSaveToNotes = useCallback");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("const handleClear = useCallback", start + 1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("NotesAmbient re-exports the shared save-failure helper", () => {
  it("imports describeNoteSaveFailure from the shared lib module, not from NotesView", () => {
    expect(src).toMatch(
      /import\s*\{\s*describeNoteSaveFailure\s*\}\s*from\s*"@\/lib\/notes\/save-failure-copy"/,
    );
    // Importing straight from NotesView.tsx would drag its whole component
    // graph (TranscriptCard, ConfirmDialog, EmptyState, Toast, PrivateText,
    // …) into every page's client bundle — NotesAmbient is rendered globally
    // from the dashboard layout, not just the Notes page. Matches any
    // NotesView import spelling (relative or aliased, either quote style —
    // 2026-09-15 landing review broadened this past the one exact aliased
    // form the original guard pinned).
    expect(src).not.toMatch(/from\s*["'][^"']*NotesView["']/);
  });

  it("the shared helper still behaves as documented (sanity check, not a re-test of its own suite)", () => {
    const msg = describeNoteSaveFailure({ kind: "network" });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).not.toMatch(/Failed to fetch|TypeError|NetworkError|Load failed/);
  });

  it("a 401 (session expiry — the likely real failure for an always-open overlay) reads as English, not a raw 'unauthorized' token (2026-09-15 landing review)", () => {
    // The exhaustive 401/403/200-unreadable case matrix lives in
    // tests/dashboard/notes-composer-save-failure-copy.test.ts (the pure
    // helper's own suite) — this is the same "sanity check, not a re-test"
    // as the network case above, scoped to the failure mode this overlay
    // actually hits: a session that expired while the panel sat open.
    const msg = describeNoteSaveFailure({ kind: "server", status: 401, error: "unauthorized" });
    expect(msg).toMatch(/session has expired/i);
    expect(msg).not.toContain("unauthorized");
  });
});

describe("NotesAmbient wires handleSaveToNotes into a status-code-driven message, not a hardcoded one", () => {
  it("passes res.status straight through to the shared helper (so a 401/403 reaches the session-expiry branch)", () => {
    const fn = extractHandleSaveToNotes();
    expect(fn).toMatch(/describeNoteSaveFailure\(\{ kind: "server", status: res\.status/);
  });
});

describe("footer layout survives a long error message without squeezing the Clear / Save to Notes buttons", () => {
  // QA 2026-09-15 landing review, finding
  // notes-ambient--error-squeezes-buttons: the session-expiry and
  // unreadable-reply strings both run 80+ characters, and the panel is only
  // w-[min(380px,calc(100vw-2rem))] wide. Whitespace-tolerant, not
  // column-anchored — these pin the shape of the fix, not its exact
  // formatting.

  it("renders the error on its own row, ahead of the status-span/button-group row, gated on saveState === \"error\"", () => {
    const errorRowIdx = src.search(/saveState\s*===\s*"error"\s*&&\s*\(/);
    const controlsRowIdx = src.search(/className\s*=\s*"flex items-center justify-between gap-2"/);
    expect(errorRowIdx).toBeGreaterThan(-1);
    expect(controlsRowIdx).toBeGreaterThan(-1);
    // The error row is emitted before the status-span/button-group row, so
    // it sits above it in the rendered footer.
    expect(errorRowIdx).toBeLessThan(controlsRowIdx);
  });

  it("the error row wraps long text instead of forcing it onto one line", () => {
    const errorRow = src.slice(
      src.search(/saveState\s*===\s*"error"\s*&&\s*\(/),
      src.indexOf("errorMsg", src.search(/saveState\s*===\s*"error"\s*&&\s*\(/)) + 200,
    );
    expect(errorRow).toMatch(/break-words/);
  });

  it("the button group does not shrink to make room and the status span can shrink to make room for it", () => {
    expect(src).toMatch(/className\s*=\s*"flex items-center gap-1\.5\s+shrink-0"/);
    expect(src).toMatch(/className\s*=\s*"min-w-0\s+text-\[11px\]\s+text-ink-faint"/);
  });
});

describe("a sticky save error clears once the user changes the draft again", () => {
  // QA 2026-09-15 landing review, finding
  // notes-ambient--error-message-sticky-until-next-save: saveState only
  // reset on a successful save, so a failed save's message (and the lost
  // "⌘; toggle · Esc close" hint under it) sat in the footer forever, even
  // after the user retyped. Fixed via a shared reset invoked from the
  // handlers that change `draft` (not a useEffect keyed on draft — a
  // setState call synchronously inside an Effect body is flagged by this
  // repo's react-hooks/set-state-in-effect lint rule).

  it("defines a reset that only downgrades an \"error\" saveState (never clobbers saving/saved) and always clears errorMsg", () => {
    const start = src.indexOf("clearStickyError");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("handleSaveToNotes", start));
    expect(block).toMatch(/prev\s*===\s*"error"\s*\?\s*"idle"\s*:\s*prev/);
    expect(block).toMatch(/setErrorMsg\(null\)/);
  });

  it("the textarea's onChange calls the reset alongside setDraft", () => {
    const onChangeStart = src.indexOf("onChange={(e) => {");
    expect(onChangeStart).toBeGreaterThan(-1);
    const onChangeBlock = src.slice(onChangeStart, src.indexOf("}}", onChangeStart));
    expect(onChangeBlock).toMatch(/setDraft\(e\.target\.value\)/);
    expect(onChangeBlock).toMatch(/clearStickyError\(\)/);
  });

  it("handleClear also calls the reset — clearing the draft is itself a draft change", () => {
    const start = src.indexOf("const handleClear = useCallback");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("// Closed: render nothing", start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/setDraft\(""\)/);
    expect(fn).toMatch(/clearStickyError\(\)/);
  });
});

describe("handleSaveToNotes routes every failure through the helper", () => {
  it("no longer reads err.message or throws a raw Error", () => {
    const fn = extractHandleSaveToNotes();
    expect(fn).not.toMatch(/err instanceof Error/);
    expect(fn).not.toMatch(/throw new Error/);
  });

  it("guards the fetch and the JSON parse, and checks both res.ok and data.success", () => {
    const fn = extractHandleSaveToNotes();
    expect(fn).toMatch(/apiFetch\([\s\S]*?\)\.catch\(\(\) => null\)/);
    expect(fn).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/);
    expect(fn).toMatch(/!res\.ok \|\| !data\?\.success/);
  });

  it("classifies a rejected fetch as a network failure via the shared helper", () => {
    const fn = extractHandleSaveToNotes();
    expect(fn).toMatch(/describeNoteSaveFailure\(\{ kind: "network" \}\)/);
  });

  it("classifies a non-OK / unsuccessful response as a server failure via the shared helper", () => {
    const fn = extractHandleSaveToNotes();
    expect(fn).toMatch(/describeNoteSaveFailure\(\s*\{\s*kind: "server"/);
  });

  it("keeps the draft on failure — the reset only happens after a success", () => {
    const fn = extractHandleSaveToNotes();
    const firstFailure = fn.indexOf("describeNoteSaveFailure");
    const reset = fn.indexOf('setDraft("")');
    expect(firstFailure).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(firstFailure);
    // Every failure branch returns before reaching the reset.
    const failureBlock = fn.slice(firstFailure, reset);
    expect((failureBlock.match(/\breturn;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
