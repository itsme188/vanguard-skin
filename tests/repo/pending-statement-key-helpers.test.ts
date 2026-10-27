/**
 * T-KEY-HELPERS (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12): pending state is read through ONE module and joined on ONE key.
 *
 * Source scan of lib/ and app/ (comments stripped):
 *  - no file other than lib/queries/pending-statement.ts names
 *    `pendingStatementKey` or writes a pending key
 *    (`${account}:${security}:${side}`), with one reviewed exception below;
 *  - the importers of lib/queries/pending-statement are an allowed list,
 *    each with its reason; an entry that no longer imports it fails (stale).
 * Importers of pending-statement-types.ts and ledger-side-routing.ts are
 * unrestricted (pure helpers, no pending state).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const READ_MODEL = "lib/queries/pending-statement.ts";

/** Who may import the read model, and why. */
const ALLOWED_IMPORTERS: Record<string, string> = {
  "lib/queries/tax-lots.ts": "Tax Lots readers decorate lots and build the summary from the index",
  "lib/queries/portfolio-summary.ts": "the chat summary splits pending sides out of its tax lines",
  "lib/queries/chat-tools.ts": "the chat tax-lot and holdings tools mark pending lots and filter closed-per-live pairs",
  "lib/queries/integrity-checks.ts": "the lot-drift scan reads the index to classify pending pairs",
  "lib/queries/closing-entry-account-mismatch.ts": "the account-mismatch scan reads the pending pairs' types",
};

/**
 * Files other than the read model that build an `a:s:side` string, and why
 * it is not a pending key. Reviewed: the reducer and the position counter
 * de-duplicate (account, security, side) inside one call; the string is
 * never compared with the index and the file does not import the read model.
 */
const KEY_SHAPE_EXCEPTIONS: Record<string, string> = {
  "lib/queries/pending-statement-types.ts": "local de-duplication inside reducePendingDisclosure / countPendingPositions",
};

/** A template literal that is exactly `${a}:${b}:${side}` (or a literal side). */
const PENDING_KEY_SHAPE = /`\$\{[^`{}]+\}:\$\{[^`{}]+\}:(?:\$\{[^`{}]*(?:side|short)[^`{}]*\}|long|short)`/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Remove // and block comments, keeping string and template contents. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i += 1;
  }
  return out;
}

const FILES = [...walk("lib"), ...walk("app")];
const SOURCES = new Map(FILES.map((f) => [f, stripComments(fs.readFileSync(path.join(ROOT, f), "utf8"))]));

/** Does `file` import the read model (alias or relative path, static or dynamic)? */
function importsReadModel(file: string, src: string): boolean {
  const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
  return specs.some((spec) => {
    if (spec === "@/lib/queries/pending-statement") return true;
    if (!spec.startsWith(".")) return false;
    const resolved = path.normalize(path.join(path.dirname(file), spec));
    return resolved === "lib/queries/pending-statement" || resolved === "lib/queries/pending-statement.ts";
  });
}

describe("T-KEY-HELPERS", () => {
  it("the scan is live: it sees the read model's own key builder", () => {
    expect(PENDING_KEY_SHAPE.test(SOURCES.get(READ_MODEL)!)).toBe(true);
    expect(SOURCES.get(READ_MODEL)!).toContain("export function pendingStatementKey");
  });

  it("no file other than the read model names pendingStatementKey", () => {
    const offenders = FILES.filter((f) => f !== READ_MODEL && /\bpendingStatementKey\b/.test(SOURCES.get(f)!));
    expect(offenders).toEqual([]);
  });

  it("no file other than the read model writes a pending key (account:security:side)", () => {
    const offenders = FILES.filter(
      (f) => f !== READ_MODEL && !(f in KEY_SHAPE_EXCEPTIONS) && PENDING_KEY_SHAPE.test(SOURCES.get(f)!)
    );
    expect(offenders).toEqual([]);
  });

  it("each key-shape exception still has the shape (not stale) and never imports the read model", () => {
    for (const f of Object.keys(KEY_SHAPE_EXCEPTIONS)) {
      expect([f, PENDING_KEY_SHAPE.test(SOURCES.get(f) ?? "")]).toEqual([f, true]);
      expect([f, importsReadModel(f, SOURCES.get(f)!)]).toEqual([f, false]);
    }
  });

  it("the read model's importers are exactly the allowed list (a stale entry fails)", () => {
    const importers = FILES.filter((f) => f !== READ_MODEL && importsReadModel(f, SOURCES.get(f)!)).sort();
    expect(importers).toEqual(Object.keys(ALLOWED_IMPORTERS).sort());
  });
});
