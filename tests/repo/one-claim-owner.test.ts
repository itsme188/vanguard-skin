/**
 * Spec §8, E line: "one claim owner across sweep, nudge, manual route".
 *
 * After slice E exactly four modules may CALL `claimEarningsEmailSlot`, and
 * exactly two may reach the mailer, and each exception is JUSTIFIED in the
 * tables below rather than merely listed. Anything else that wants to send an
 * earnings email calls `sendEarningsCandidate`; anything that wants to send ONE
 * email covering several claimed events calls `deliverClaimedBatch`.
 *
 * ── The MATCH UNIT ──────────────────────────────────────────────────────────
 * Claims are detected as CALLS (`claimEarningsEmailSlot(`), which is the shape
 * a second claim owner takes.
 *
 * The mailer is detected as an IMPORT of `sendEmail` from `@/lib/email` (or a
 * direct call, for an aliased re-export), NOT as a call site. That is
 * deliberate: `lib/earnings/send-service.ts` — the one module that is SUPPOSED
 * to own the provider call — hides it behind an injectable seam
 * (`const send = seams.sendEmail ?? sendEmail`) and never writes `sendEmail(`
 * at all, so a call-site scan would silently miss it. Missing the file that
 * owns the mailer is the wrong failure direction for this guard: what matters
 * is which modules can reach the wire at all.
 *
 * Both scans are whole-file text, comments included, so a doc comment written
 * as `name(` counts as an occurrence. Over-strict is the safe direction here;
 * the tree contains no such comment today.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirnameLocal = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirnameLocal, "../..");

const SCAN_ROOTS = ["lib", "app", "scripts"];
const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".next",
  "dist",
  ".claude",
  ".superpowers",
  "docs",
  ".git",
  "tests",
]);

interface Exemption {
  file: string;
  why: string;
}

/**
 * Keep the shape trivially amendable — a file plus the reason it is allowed.
 */
const CLAIM_CALLERS: Exemption[] = [
  {
    file: "lib/digest/send-earnings-email.ts",
    why: "defines claimEarningsEmailSlot and the rest of the claim state machine; the definition itself matches the call pattern.",
  },
  {
    file: "lib/earnings/send-service.ts",
    why: "the canonical per-event send path — sweep, nudge and the manual route all reach the claim through this one module.",
  },
  {
    file: "lib/earnings/debrief-send.ts",
    why: "batch: ONE stapled email covers N events, so it must claim them all before composing. It delivers through deliverClaimedBatch (Task 5b), so the lifecycle is still single-sourced.",
  },
  {
    file: "lib/earnings/wrap-send.ts",
    why: "RETIRED code — not invoked since 2026-08-02. It keeps the primitives so the module still type-checks; its header comment says it is OUTSIDE the send lifecycle and must adopt deliverClaimedBatch before any revival. Delete this entry when the module is deleted.",
  },
];

const MAILER_USERS: Exemption[] = [
  {
    file: "lib/earnings/send-service.ts",
    why: "deliverClaimedBatch is the one provider call for every earnings email — it is the module this whole guard exists to protect.",
  },
  {
    file: "lib/earnings/wrap-send.ts",
    why: "RETIRED — see the claim table above. It stays on this list until the module is deleted or ported onto deliverClaimedBatch.",
  },
];

// ─── File collection ──────────────────────────────────────────────────────

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function collectTargetFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_ROOTS) collectFiles(path.join(REPO_ROOT, dir), out);
  return out;
}

// ─── The two detectors ────────────────────────────────────────────────────

const CLAIM_CALL = /claimEarningsEmailSlot\s*\(/;
const MAILER_IMPORT = /import\s*\{[^}]*\bsendEmail\b[^}]*\}\s*from\s*"@\/lib\/email"/;
const MAILER_CALL = /\bsendEmail\s*\(/;

export function callsClaim(src: string): boolean {
  return CLAIM_CALL.test(src);
}

export function reachesMailer(src: string): boolean {
  return MAILER_IMPORT.test(src) || MAILER_CALL.test(src);
}

function filesMatching(
  predicate: (src: string) => boolean,
  within: (rel: string) => boolean,
): string[] {
  return collectTargetFiles()
    .map((abs) => path.relative(REPO_ROOT, abs).split(path.sep).join("/"))
    .filter((rel) => within(rel) && predicate(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8")))
    .sort();
}

const expected = (list: Exemption[]) => list.map((e) => e.file).sort();

describe("one claim owner", () => {
  it("the walk is actually finding files (guards against a typo'd root)", () => {
    expect(collectTargetFiles().length).toBeGreaterThan(200);
  });

  it("claimEarningsEmailSlot is called from exactly the justified modules", () => {
    expect(
      filesMatching(callsClaim, (rel) => /^(lib|app|scripts)\//.test(rel)),
      "a second claim owner is a double-send waiting to happen — call sendEarningsCandidate " +
        "(one event) or deliverClaimedBatch (one email, N claimed events) instead, or add a " +
        "justified entry to CLAIM_CALLERS in this file",
    ).toEqual(expected(CLAIM_CALLERS));
  });

  it("no earnings module reaches the mailer except the ones listed", () => {
    expect(
      filesMatching(
        reachesMailer,
        (rel) => rel.startsWith("lib/earnings/") || rel === "lib/digest/send-earnings-email.ts",
      ),
      "an earnings module that reaches @/lib/email directly bypasses the sending row, the " +
        "Message-ID, the timeout classification and the terminal delivery-unknown state — " +
        "deliver through lib/earnings/send-service.ts instead",
    ).toEqual(expected(MAILER_USERS));
  });

  it("the composer module no longer sends anything itself", () => {
    // It defines the claim primitives and composes; the send service drives them.
    const src = fs.readFileSync(path.join(REPO_ROOT, "lib/digest/send-earnings-email.ts"), "utf8");
    expect(reachesMailer(src)).toBe(false);
  });

  it("every exemption carries a real justification", () => {
    for (const e of [...CLAIM_CALLERS, ...MAILER_USERS]) {
      expect(e.why.length, e.file).toBeGreaterThan(40);
    }
  });

  it("every exemption names a file that still exists", () => {
    for (const e of [...CLAIM_CALLERS, ...MAILER_USERS]) {
      expect(fs.existsSync(path.join(REPO_ROOT, e.file)), e.file).toBe(true);
    }
  });

  it("wrap-send says in its own header that it is outside the lifecycle", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "lib/earnings/wrap-send.ts"), "utf8");
    expect(src).toContain("deliverClaimedBatch");
    expect(src.slice(0, 2000)).toMatch(/retired|outside the (send )?lifecycle/i);
  });

  // ─── Self-tests: the detectors' own behaviour, on planted source ─────────

  it("self-test: a claim call is detected, a mention is not", () => {
    expect(callsClaim(`const c = claimEarningsEmailSlot(db, 1, "recap", to);`)).toBe(true);
    expect(callsClaim(`// claimEarningsEmailSlot in lib/digest/send-earnings-email.ts refuses`)).toBe(
      false,
    );
    expect(callsClaim(`import { claimEarningsEmailSlot } from "@/lib/digest/send-earnings-email";`)).toBe(
      false,
    );
  });

  it("self-test: the mailer is detected through a seam alias, not just a call", () => {
    const seamed = `
      import { sendEmail } from "@/lib/email";
      const send = seams.sendEmail ?? sendEmail;
      await send({ to, subject, html });
    `;
    expect(reachesMailer(seamed)).toBe(true);
    expect(MAILER_CALL.test(seamed)).toBe(false); // the call-site scan alone would miss it
    expect(reachesMailer(`import { briefingToHtml } from "@/lib/calendar/briefing-html";`)).toBe(false);
  });
});
