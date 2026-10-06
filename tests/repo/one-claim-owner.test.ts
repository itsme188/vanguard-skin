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
 * The mailer is detected as REACHABILITY, not as a call site. That is
 * deliberate: `lib/earnings/send-service.ts` — the one module that is SUPPOSED
 * to own the provider call — hides it behind an injectable seam
 * (`const send = seams.sendEmail ?? sendEmail`) and never writes `sendEmail(`
 * at all, so a call-site scan would silently miss it. Missing the file that
 * owns the mailer is the wrong failure direction for this guard: what matters
 * is which modules can reach the wire at all.
 *
 * A module reaches the mailer when ANY of these holds (`reachesMailer`):
 *   1. it names the mailer module (`@/lib/email`, or a relative path to it) in
 *      a static `import` that binds a value — a named `sendEmail` (aliased or
 *      not), a namespace `* as m`, or a default binding;
 *   2. it RE-EXPORTS from the mailer module (`export { sendEmail } from`,
 *      `export * from`) — handing the mailer on under its own name;
 *   3. it loads the mailer module DYNAMICALLY (`import("@/lib/email")`,
 *      `require("@/lib/email")`) — no import clause to scan at all;
 *   4. it writes a direct `sendEmail(` call (a global, an injected binding);
 *   5. it imports a value from a WRAPPER — any other scanned module that itself
 *      reaches the mailer by 1–4 and is not on MAILER_USERS. A one-line
 *      `export const mail = (o) => sendEmail(o)` in lib/notify.ts is the same
 *      bypass with one more hop, and it is closed over transitively (a wrapper
 *      of a wrapper counts).
 *
 * A type-only import (`import type { SendEmailOptions }`, or a clause whose
 * every binding is `type X`) is NOT reachability: it erases at compile time.
 * Importing from a MAILER_USERS module is not a wrapper hop either — that is
 * the sanctioned route (`deliverClaimedBatch` lives in one).
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
const MAILER_CALL = /\bsendEmail\s*\(/;
const MAILER_MODULE = "lib/email";

export function callsClaim(src: string): boolean {
  return CLAIM_CALL.test(src);
}

/** A module reference found in source: what it binds and where it points. */
interface ModuleRef {
  /** "import" / "export" (static, with a clause) or "dynamic" (import()/require()). */
  form: "import" | "export" | "dynamic";
  /** The clause between the keyword and `from`; "" for dynamic and side-effect forms. */
  clause: string;
  specifier: string;
}

/** Every static import, re-export, dynamic import() and require() in a source text. */
export function moduleRefs(src: string): ModuleRef[] {
  const out: ModuleRef[] = [];
  const STATIC = /\b(import|export)\b([^;'"`]*?)\bfrom\s*(["'`])([^"'`]+)\3/g;
  for (const m of src.matchAll(STATIC)) {
    // The lazy clause can start at an earlier bare word ("// we import …"); the
    // real clause is whatever follows the LAST keyword before `from`.
    const clause = (m[2].split(/\b(?:import|export)\b/).pop() ?? "").trim();
    out.push({ form: m[1] as "import" | "export", clause, specifier: m[4] });
  }
  const DYNAMIC = /\b(?:import|require)\s*\(\s*(["'`])([^"'`]+)\1/g;
  for (const m of src.matchAll(DYNAMIC)) {
    out.push({ form: "dynamic", clause: "", specifier: m[2] });
  }
  return out;
}

/**
 * Repo-relative module id (no extension) a specifier points at, from the file
 * that wrote it. `null` for a bare package specifier.
 */
export function resolveSpecifier(specifier: string, fromRel: string): string | null {
  let target: string;
  if (specifier.startsWith("@/")) target = specifier.slice(2);
  else if (specifier.startsWith(".")) {
    target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  } else return null;
  return target.replace(/\.(tsx?|jsx?)$/, "").replace(/\/index$/, "");
}

/** Does this import/export clause bind a VALUE (anything that survives compilation)? */
function bindsValue(ref: ModuleRef): boolean {
  if (ref.form === "dynamic") return true;
  const clause = ref.clause;
  if (/^type\b/.test(clause)) return false; // `import type …` / `export type …`
  const braces = /\{([^}]*)\}/.exec(clause);
  if (!braces) return true; // default, namespace (`* as m`) or `export *`
  const outside = clause.replace(braces[0], "").replace(/,/g, "").trim();
  if (outside !== "") return true; // `dflt, { … }` / `* as m, { … }`
  return braces[1]
    .split(",")
    .map((b) => b.trim())
    .some((b) => b !== "" && !/^type\b/.test(b));
}

/** Shapes 1–3: a value-level reference to the mailer module itself. */
function refNamesMailer(ref: ModuleRef, fromRel: string): boolean {
  if (resolveSpecifier(ref.specifier, fromRel) !== MAILER_MODULE) return false;
  if (ref.form !== "import") return true; // any re-export, any dynamic load
  if (!bindsValue(ref)) return false;
  const braces = /\{([^}]*)\}/.exec(ref.clause);
  // A purely-named import reaches the mailer only if it names the mailer;
  // a namespace or default binding carries it along unnamed.
  if (braces && ref.clause.replace(braces[0], "").replace(/,/g, "").trim() === "") {
    return /\bsendEmail\b/.test(braces[1]);
  }
  return true;
}

/** Shapes 1–4 on one file, with no knowledge of any other. */
export function reachesMailerDirectly(src: string, fromRel = "lib/earnings/planted.ts"): boolean {
  return MAILER_CALL.test(src) || moduleRefs(src).some((r) => refNamesMailer(r, fromRel));
}

/**
 * Shape 5 closed over transitively: the set of scanned modules (ids, no
 * extension) through which the mailer can be reached. `sanctioned` modules are
 * the justified owners — they reach the mailer, but importing from one is the
 * approved route, so they never propagate.
 */
export function mailerCarriers(
  sources: Map<string, string>,
  sanctioned: Set<string> = new Set(),
): Set<string> {
  const idOf = (rel: string) => rel.replace(/\.tsx?$/, "").replace(/\/index$/, "");
  const carriers = new Set<string>();
  for (const [rel, src] of sources) {
    if (idOf(rel) !== MAILER_MODULE && reachesMailerDirectly(src, rel)) carriers.add(idOf(rel));
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [rel, src] of sources) {
      const id = idOf(rel);
      if (carriers.has(id) || id === MAILER_MODULE) continue;
      const viaWrapper = moduleRefs(src).some((ref) => {
        if (!bindsValue(ref)) return false;
        const target = resolveSpecifier(ref.specifier, rel);
        return target != null && carriers.has(target) && !sanctioned.has(target);
      });
      if (viaWrapper) {
        carriers.add(id);
        grew = true;
      }
    }
  }
  return carriers;
}

/**
 * The full detector. `others` is the rest of the tree (repo-relative path →
 * source), which is what lets a wrapper module be seen; omit it and only the
 * file's own shapes (1–4) are judged.
 */
export function reachesMailer(
  src: string,
  fromRel = "lib/earnings/planted.ts",
  others: Map<string, string> = new Map(),
  sanctioned: Set<string> = new Set(),
): boolean {
  const sources = new Map(others);
  sources.set(fromRel, src);
  return mailerCarriers(sources, sanctioned).has(
    fromRel.replace(/\.tsx?$/, "").replace(/\/index$/, ""),
  );
}

function readTree(): Map<string, string> {
  const out = new Map<string, string>();
  for (const abs of collectTargetFiles()) {
    out.set(path.relative(REPO_ROOT, abs).split(path.sep).join("/"), fs.readFileSync(abs, "utf8"));
  }
  return out;
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

  const inEarningsScope = (rel: string) =>
    rel.startsWith("lib/earnings/") || rel === "lib/digest/send-earnings-email.ts";
  const moduleId = (rel: string) => rel.replace(/\.tsx?$/, "").replace(/\/index$/, "");
  const sanctionedIds = new Set(MAILER_USERS.map((e) => moduleId(e.file)));

  it("no earnings module reaches the mailer except the ones listed", () => {
    // Direct reach AND reach through a wrapper module anywhere in the tree.
    const tree = readTree();
    const carriers = mailerCarriers(tree, sanctionedIds);
    expect(
      [...tree.keys()].filter((rel) => inEarningsScope(rel) && carriers.has(moduleId(rel))).sort(),
      "an earnings module that reaches @/lib/email — directly, by a dynamic import, by a " +
        "re-export, or through a wrapper module that forwards to it — bypasses the sending " +
        "row, the Message-ID, the timeout classification and the terminal delivery-unknown " +
        "state — deliver through lib/earnings/send-service.ts instead",
    ).toEqual(expected(MAILER_USERS));
  });

  it("the composer module no longer sends anything itself", () => {
    // It defines the claim primitives and composes; the send service drives them.
    const rel = "lib/digest/send-earnings-email.ts";
    const tree = readTree();
    expect(reachesMailer(tree.get(rel)!, rel, tree, sanctionedIds)).toBe(false);
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

  it("self-test: every static import spelling of the mailer is detected", () => {
    for (const src of [
      `import { sendEmail as deliver } from "@/lib/email";`,
      `import { type SendEmailOptions, sendEmail } from '@/lib/email';`,
      `import * as mail from "@/lib/email";`,
      `import mailer from "@/lib/email";`,
      `import {\n  sendEmail,\n} from "@/lib/email";`,
      `import { sendEmail } from "../email";`, // relative, from lib/earnings/
      `import { sendEmail } from "../email.ts";`,
    ]) {
      expect(reachesMailer(src), src).toBe(true);
    }
  });

  it("self-test: a type-only import of the mailer module is NOT reachability", () => {
    for (const src of [
      `import type { SendEmailOptions } from "@/lib/email";`,
      `import { type SendEmailOptions, type SendEmailResult } from "@/lib/email";`,
      `// we import the options type only\nimport type { SendEmailOptions } from "@/lib/email";`,
      `import { DELIVERY_UNKNOWN } from "./email-states";`, // a sibling that merely starts with "email"
      `import { recordCloudSentAudit } from "@/lib/mutations/earnings-emails";`,
    ]) {
      expect(reachesMailer(src), src).toBe(false);
    }
  });

  it("self-test: a DYNAMIC import of the mailer is detected", () => {
    for (const src of [
      `const { sendEmail: go } = await import("@/lib/email");\nawait go(opts);`,
      `const mail = await import('../email');\nawait mail["sendEmail"](opts);`,
      "const mail = await import(`@/lib/email`);",
      `const mail = require("@/lib/email");`,
      `void import(\n  "@/lib/email"\n).then((m) => m.sendEmail);`,
    ]) {
      expect(reachesMailer(src), src).toBe(true);
      // None of them is an `import { sendEmail } from` — the old detector's only shape.
      expect(/import\s*\{[^}]*\bsendEmail\b[^}]*\}\s*from\s*"@\/lib\/email"/.test(src), src).toBe(false);
    }
  });

  it("self-test: a RE-EXPORT of the mailer is detected", () => {
    for (const src of [
      `export { sendEmail } from "@/lib/email";`,
      `export { sendEmail as deliver } from "@/lib/email";`,
      `export * from "@/lib/email";`,
      `export * as mail from "../email";`,
    ]) {
      expect(reachesMailer(src), src).toBe(true);
    }
  });

  it("self-test: a WRAPPER module that forwards to the mailer is detected through the import", () => {
    const wrapper = `
      import { sendEmail } from "@/lib/email";
      export const deliver = (o: unknown) => sendEmail(o as never);
    `;
    const user = `import { deliver } from "@/lib/notify/deliver";\nawait deliver(opts);`;
    const tree = new Map([["lib/notify/deliver.ts", wrapper]]);
    const rel = "lib/earnings/sneaky.ts";

    expect(reachesMailerDirectly(user, rel)).toBe(false); // nothing in the file itself says "mailer"
    expect(reachesMailer(user, rel, tree)).toBe(true);
    // Relative spelling of the same wrapper, and a dynamic load of it.
    expect(reachesMailer(`import { deliver } from "../notify/deliver";`, rel, tree)).toBe(true);
    expect(reachesMailer(`const m = await import("@/lib/notify/deliver");`, rel, tree)).toBe(true);
    // A type-only import of the wrapper carries nothing.
    expect(reachesMailer(`import type { Opts } from "@/lib/notify/deliver";`, rel, tree)).toBe(false);
  });

  it("self-test: wrappers are followed transitively, and through a re-export barrel", () => {
    const tree = new Map([
      ["lib/notify/deliver.ts", `const m = await import("@/lib/email");\nexport const deliver = m.sendEmail;`],
      ["lib/notify/index.ts", `export * from "./deliver";`],
      ["lib/notify/outer.ts", `import { deliver } from "@/lib/notify";\nexport const outer = deliver;`],
      ["lib/calendar/plain.ts", `export const plain = 1;`],
    ]);
    const rel = "lib/earnings/sneaky.ts";
    expect(reachesMailer(`import { outer } from "@/lib/notify/outer";`, rel, tree)).toBe(true);
    expect(reachesMailer(`import { deliver } from "@/lib/notify";`, rel, tree)).toBe(true);
    expect(reachesMailer(`import { plain } from "@/lib/calendar/plain";`, rel, tree)).toBe(false);
  });

  it("self-test: importing from a SANCTIONED mailer owner is the approved route, not a wrapper hop", () => {
    const owner = `import { sendEmail } from "@/lib/email";\nexport async function deliverClaimedBatch() {}`;
    const tree = new Map([["lib/earnings/send-service.ts", owner]]);
    const user = `import { deliverClaimedBatch } from "@/lib/earnings/send-service";`;
    const rel = "lib/earnings/debrief-like.ts";
    // Allowlist semantics unchanged: the owner itself still counts as reaching…
    expect(mailerCarriers(tree, new Set(["lib/earnings/send-service"])).has("lib/earnings/send-service")).toBe(true);
    // …its callers do not — unless it is NOT on the list, when it is just a wrapper.
    expect(reachesMailer(user, rel, tree, new Set(["lib/earnings/send-service"]))).toBe(false);
    expect(reachesMailer(user, rel, tree)).toBe(true);
  });

  it("self-test: specifiers resolve to repo-relative module ids", () => {
    expect(resolveSpecifier("@/lib/email", "lib/earnings/a.ts")).toBe("lib/email");
    expect(resolveSpecifier("../email", "lib/earnings/a.ts")).toBe("lib/email");
    expect(resolveSpecifier("../../email.ts", "lib/earnings/prepare-steps/a.ts")).toBe("lib/email");
    expect(resolveSpecifier("./email-states", "lib/earnings/a.ts")).toBe("lib/earnings/email-states");
    expect(resolveSpecifier("@/lib/notify/index", "lib/earnings/a.ts")).toBe("lib/notify");
    expect(resolveSpecifier("nodemailer", "lib/earnings/a.ts")).toBeNull();
    expect(moduleRefs(`import a from "x";\nexport { b } from './y';\nimport("z");`)).toEqual([
      { form: "import", clause: "a", specifier: "x" },
      { form: "export", clause: "{ b }", specifier: "./y" },
      { form: "dynamic", clause: "", specifier: "z" },
    ]);
  });
});
