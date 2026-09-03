/**
 * Spec §4.1: every consumer of the symbol-status / event-coverage helpers is
 * named here with its declared effect. A new call site fails this test until
 * it is classified — so nobody can silently add a held/watchlist-only gate
 * (or an event decision keyed on the display-only `armed` status).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Effect = "selection-covered" | "symbol-armed" | "unchanged-push-gate" | "display" | "helper";
interface AllowEntry { file: string; fn: "getSymbolStatus" | "getSymbolStatusDetailed" | "coveredForEvents" | "coveredForEvent" | "isEventArmed" | "getArmedEventIds"; effect: Effect; }

const ALLOWLIST: AllowEntry[] = [
  { file: "lib/queries/briefing-symbols.ts", fn: "getSymbolStatusDetailed", effect: "helper" },
  { file: "lib/queries/briefing-symbols.ts", fn: "getArmedEventIds", effect: "helper" },
  { file: "lib/queries/briefing-symbols.ts", fn: "coveredForEvents", effect: "helper" },
  { file: "lib/calendar/enrichment-runner.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/calendar/enrichment-runner.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/cloud-reconcile.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/alerts/read-through-push.ts", fn: "getSymbolStatus", effect: "unchanged-push-gate" },
  { file: "lib/earnings/extract-newsletter-bogeys.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/bogeys-reminder.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/verify-earnings-dates.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/calendar/wire-probe.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/wrap.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/earnings/debrief.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/queries/earnings-cockpit.ts", fn: "coveredForEvents", effect: "selection-covered" },
  { file: "lib/queries/earnings-cockpit.ts", fn: "getSymbolStatus", effect: "display" },
  { file: "lib/digest/todays-reporters.ts", fn: "getSymbolStatus", effect: "display" },
  { file: "app/dashboard/today/EarningsHub.tsx", fn: "getSymbolStatus", effect: "display" },
  { file: "lib/digest/call-transcripts.ts", fn: "getSymbolStatus", effect: "symbol-armed" },
  { file: "lib/transcripts/same-day.ts", fn: "getSymbolStatus", effect: "symbol-armed" },
  // Task 6: updateCalendarEvent writes the outbox row only when the edited event is armed.
  { file: "lib/mutations/calendar.ts", fn: "isEventArmed", effect: "helper" },
];

const REPO = path.resolve(__dirname, "..", "..");
const ROOTS: Array<[string, RegExp]> = [["lib", /\.ts$/], ["app", /\.(ts|tsx)$/], ["scripts", /\.ts$/]];
const FN_RE = /\b(getSymbolStatusDetailed|getSymbolStatus|coveredForEvents|coveredForEvent|isEventArmed|getArmedEventIds)\s*\(/g;

function walk(dir: string, re: RegExp, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out); else if (re.test(e.name)) out.push(p);
  }
}

function occurrences(): Array<{ file: string; fn: string }> {
  const files: string[] = [];
  for (const [root, re] of ROOTS) walk(path.join(REPO, root), re, files);
  const out: Array<{ file: string; fn: string }> = [];
  for (const f of files) {
    const rel = path.relative(REPO, f);
    const src = fs.readFileSync(f, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(FN_RE)) {
      // Skip the definition site (`export function name(`).
      const before = src.slice(Math.max(0, m.index! - 40), m.index!);
      if (/function\s*$/.test(before)) continue;
      out.push({ file: rel, fn: m[1] });
    }
  }
  return out;
}

describe("symbol-status / coverage consumers are classified (spec §4.1 guard)", () => {
  it("every call site appears in the allowlist", () => {
    const missing = occurrences().filter((o) => !ALLOWLIST.some((a) => a.file === o.file && a.fn === o.fn));
    expect(missing).toEqual([]);
  });
  it("every allowlist entry still exists (no stale entries)", () => {
    const occ = occurrences();
    const stale = ALLOWLIST.filter((a) => a.effect !== "helper" && !occ.some((o) => o.file === a.file && o.fn === a.fn));
    expect(stale).toEqual([]);
  });
  it("an event decision never keys on the display-only armed status", () => {
    // Any file classified selection-covered must not compare a status to "armed".
    for (const a of ALLOWLIST.filter((x) => x.effect === "selection-covered")) {
      const src = fs.readFileSync(path.join(REPO, a.file), "utf-8");
      expect(src, a.file).not.toMatch(/===\s*["']armed["']/);
    }
  });
});
