import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

describe("LevelsPanel reactivate last-fired handling (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
  const handler = sliceBetween(src, "async function handleReactivate", "async function handleDelete");

  it("reactivate retries with force after a would-fire-immediately 409 confirmation", () => {
    expect(handler).toMatch(/force\s*=\s*false/);
    expect(handler).toMatch(/body:\s*JSON\.stringify\(\{ id, action: "reactivate", force \}\)/);
    expect(handler).toMatch(/result\.status\s*===\s*409/);
    expect(handler).toContain('"would_fire_immediately"');
    expect(handler).toMatch(/is already past this level/);
    expect(handler).toMatch(/handleReactivate\(id,\s*true\)/);
  });

  it("an out-of-range refusal gets its own confirm-and-retry, with formatted prices", () => {
    const branch = sliceBetween(handler, 'code === "beyond_scan_range"', "Couldn't reactivate the level");
    expect(branch).toMatch(/confirm\(/);
    expect(branch).toMatch(/outside the scanner's range/);
    expect(branch).toMatch(/handleReactivate\(id,\s*true\)/);
    // Prices in every refusal prompt go through the row formatter.
    expect(handler).toMatch(/formatLevelPrice\(currency, raw\.currentPrice\)/);
    expect(handler).toMatch(/formatLevelPrice\(currency, raw\.effectivePrice\)/);
    expect(handler).not.toMatch(/\$\{raw\??\.(currentPrice|effectivePrice)\}/);
  });

  it("the success toast is honest about a same-day fire and about a row the scanner ignores", () => {
    const success = sliceBetween(handler, "if (result.ok) {", 'result.code === "would_fire_immediately"');
    expect(handler).toMatch(/const alertedToday = raw\?\.alertedToday === true;/);
    expect(success).toMatch(/\} else if \(alertedToday\) \{/);
    expect(success).toContain("It already alerted today, so the next alert can come tomorrow.");
    expect(success).toMatch(/raw\?\.armed === false/);
    // "will fire on the next scan" is only promised when no fire happened today.
    const promise = success.indexOf("next scan");
    expect(promise).toBeGreaterThan(success.indexOf("alertedToday"));
  });

  it("a row that has ever fired reads Last fired at, active or paused; no Triggered wording is left", () => {
    expect(src).toContain("Last fired at {lastFiredCopy(l, currency)}");
    expect(src).toContain("last fired at {lastFiredCopy(l, currency)}");
    expect(src).not.toMatch(/Triggered at|triggered at|Triggered @|triggered @/);
    expect(src).not.toMatch(/const triggered = /);
  });

  it("the helper alone decides Pause / Reactivate: the component adds no condition of its own", () => {
    const calls = src.split("levelActionVisibility(l)").length - 1;
    expect(calls).toBe(2);
    expect(src).not.toMatch(/actionVisibility\.show(Pause|Reactivate)\s*&&/);
    expect(src).not.toMatch(/const showPause\s*=/);
    expect(src).not.toMatch(/const showReactivate\s*=/);
    expect(src).toMatch(/const \{ unarmedReview, showPause, showReactivate, showRequeue \}\s*=\s*levelActionVisibility\(l\)/);
    expect(src).toMatch(/const \{ showPause, showReactivate, showRequeue \}\s*=\s*levelActionVisibility\(l\)/);
  });

  it("alerted-today comes from the server fact, not from the browser's local date", () => {
    expect(src).not.toContain("toDateString()");
    expect(src).not.toMatch(/function triggeredToday/);
    expect(src).toMatch(/alerted_today\?: boolean/);
    expect(src).toMatch(/disabled=\{alertedToday\}/);
    const rows = src.split("const alertedToday = l.alerted_today === true;").length - 1;
    expect(rows).toBe(2);
  });
});
