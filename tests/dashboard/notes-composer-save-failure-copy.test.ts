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
