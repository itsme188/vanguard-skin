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
    // from the dashboard layout, not just the Notes page.
    expect(src).not.toMatch(/from\s*"@\/app\/dashboard\/components\/NotesView"/);
  });

  it("the shared helper still behaves as documented (sanity check, not a re-test of its own suite)", () => {
    const msg = describeNoteSaveFailure({ kind: "network" });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).not.toMatch(/Failed to fetch|TypeError|NetworkError|Load failed/);
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
