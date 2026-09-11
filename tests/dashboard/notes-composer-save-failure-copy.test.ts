/**
 * QA 2026-09-07 — research-notes-composer--raw-failed-to-fetch-error-text.
 *
 * The Notes composer printed the browser's raw TypeError message ("Failed to
 * fetch") between the Tags input and the Save Note button when the POST died
 * at the network level. Behaviour was otherwise right — the typed note was
 * retained and a retry succeeded — but the message was JS, not English.
 *
 * The Documents tag editor next door already words the same failure properly
 * ("Couldn't save tags: could not reach the server." / "Couldn't save tags
 * (server returned 500).") — this pins the composer to that style.
 *
 * The copy is a pure exported helper so it can be tested here; this repo has
 * no jsdom/RTL harness (see tests/dashboard/narrative-block-refresh.test.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeNoteSaveFailure } from "@/app/dashboard/components/NotesView";

const src = readFileSync("app/dashboard/components/NotesView.tsx", "utf8");

describe("describeNoteSaveFailure", () => {
  it("words a network failure in domain language and says the text is kept", () => {
    const msg = describeNoteSaveFailure({ kind: "network" });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).toMatch(/could not reach the server/i);
    expect(msg).toMatch(/try again/i);
    // The browser's own vocabulary never reaches the composer.
    expect(msg).not.toMatch(/Failed to fetch|TypeError|NetworkError|Load failed/);
  });

  it("passes a 4xx validation message through — the user can act on it", () => {
    const msg = describeNoteSaveFailure({
      kind: "server",
      status: 400,
      error: "Missing required fields: note_type, content",
    });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).toContain("Missing required fields: note_type, content");
  });

  it("never echoes a 5xx body — those carry raw exception text", () => {
    const msg = describeNoteSaveFailure({
      kind: "server",
      status: 500,
      error: "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed",
    });
    expect(msg).not.toContain("SQLITE_CONSTRAINT");
    expect(msg).toContain("500");
    expect(msg).toMatch(/try again/i);
  });

  it("still says something usable when the body is unparseable", () => {
    const msg = describeNoteSaveFailure({ kind: "server", status: 502 });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).toContain("502");
    expect(msg).not.toMatch(/undefined|null|NaN/);
  });

  it("has a catch-all that is still English", () => {
    const msg = describeNoteSaveFailure({ kind: "unknown" });
    expect(msg).toMatch(/couldn't save the note/i);
    expect(msg).toMatch(/try again/i);
  });

  it("words an update failure with the update verb and 'changes' subject", () => {
    const msg = describeNoteSaveFailure({ kind: "network", action: "update" });
    expect(msg).toMatch(/couldn't update the note/i);
    expect(msg).toMatch(/could not reach the server/i);
    expect(msg).toMatch(/your changes are still here/i);
    expect(msg).not.toMatch(/Failed to fetch|TypeError|NetworkError|Load failed/);
  });

  it("words a delete failure with the delete verb and no 'still here' claim", () => {
    const msg = describeNoteSaveFailure({ kind: "network", action: "delete" });
    expect(msg).toMatch(/couldn't delete the note/i);
    expect(msg).toMatch(/could not reach the server/i);
    expect(msg).toMatch(/try again/i);
    // Nothing is "still here" to preserve on a delete — only save/update
    // promise that.
    expect(msg).not.toMatch(/still here/i);
  });

  it("passes a 4xx body through for update/delete server failures too", () => {
    const updateMsg = describeNoteSaveFailure({
      kind: "server",
      status: 404,
      error: "Note not found",
      action: "update",
    });
    expect(updateMsg).toMatch(/couldn't update the note/i);
    expect(updateMsg).toContain("Note not found");

    const deleteMsg = describeNoteSaveFailure({
      kind: "server",
      status: 404,
      error: "Note not found",
      action: "delete",
    });
    expect(deleteMsg).toMatch(/couldn't delete the note/i);
    expect(deleteMsg).toContain("Note not found");
  });

  it("never echoes a 5xx body for update/delete either", () => {
    const msg = describeNoteSaveFailure({
      kind: "server",
      status: 500,
      error: "SQLITE_CONSTRAINT: FOREIGN KEY constraint failed",
      action: "delete",
    });
    expect(msg).not.toContain("SQLITE_CONSTRAINT");
    expect(msg).toContain("500");
  });
});

describe("NotesView update/delete handlers route every failure through the helper", () => {
  function extractFn(name: string): string {
    const start = src.indexOf(`async function ${name}`);
    expect(start).toBeGreaterThan(-1);
    // Both handlers are followed by a "// ─── ... ───" section comment.
    const next = src.indexOf("\n  // ─── ", start + 1);
    expect(next).toBeGreaterThan(start);
    return src.slice(start, next);
  }

  it("handleUpdate no longer throws/reads err.message into the toast", () => {
    const fn = extractFn("handleUpdate");
    expect(fn).not.toMatch(/err instanceof Error/);
    expect(fn).not.toContain("Failed to update note");
    expect(fn).not.toMatch(/throw new Error/);
    expect(fn).toMatch(/!res\.ok \|\| !data\?\.success/);
    expect(fn).toMatch(/describeNoteSaveFailure\(\{ kind: "network", action: "update" \}\)/);
    expect(fn).toMatch(/describeNoteSaveFailure\(\s*\{\s*kind: "server"/);
    expect(fn).toContain('action: "update"');
    // JSON parse is guarded — a non-JSON body must not throw a raw SyntaxError.
    expect(fn).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/);
  });

  it("handleDelete no longer throws/reads err.message into the toast", () => {
    const fn = extractFn("handleDelete");
    expect(fn).not.toMatch(/err instanceof Error/);
    expect(fn).not.toContain("Failed to delete note");
    expect(fn).not.toMatch(/throw new Error/);
    expect(fn).toMatch(/!res\.ok \|\| !data\?\.success/);
    expect(fn).toMatch(/describeNoteSaveFailure\(\{ kind: "network", action: "delete" \}\)/);
    expect(fn).toMatch(/describeNoteSaveFailure\(\s*\{\s*kind: "server"/);
    expect(fn).toContain('action: "delete"');
    expect(fn).toMatch(/res\.json\(\)\.catch\(\(\) => null\)/);
  });
});

describe("NotesView create handler routes every failure through the helper", () => {
  it("no longer sets a raw Error message as the composer's error text", () => {
    const create = src.slice(
      src.indexOf("async function handleCreate"),
      src.indexOf("// ─── Update note ───"),
    );
    expect(create.length).toBeGreaterThan(0);
    expect(create).not.toMatch(/setSaveError\([^)]*err instanceof Error/);
    expect(create).not.toContain("Failed to save note");
    expect(create).toMatch(/setSaveError\(describeNoteSaveFailure\(\{ kind: "network" \}\)\)/);
    expect(create).toMatch(/setSaveError\(\s*describeNoteSaveFailure\(\{ kind: "server"/);
  });

  it("checks res.ok AND data.success, per the mutating-handler convention", () => {
    const create = src.slice(
      src.indexOf("async function handleCreate"),
      src.indexOf("// ─── Update note ───"),
    );
    expect(create).toMatch(/!res\.ok \|\| !data\?\.success/);
  });

  it("keeps the typed note on a failure — the form only resets after a success", () => {
    const create = src.slice(
      src.indexOf("async function handleCreate"),
      src.indexOf("// ─── Update note ───"),
    );
    const firstFailure = create.indexOf("describeNoteSaveFailure");
    const reset = create.indexOf('setFormContent("")');
    expect(firstFailure).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(firstFailure);
    // Every failure branch returns before reaching the reset.
    const failureBlock = create.slice(firstFailure, reset);
    expect((failureBlock.match(/\breturn;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
