import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

describe("LevelsPanel reactivate last-fired handling (source pin)", () => {
  const src = readFileSync("app/dashboard/components/LevelsPanel.tsx", "utf8");
  const handler = sliceBetween(src, "async function handleReactivate", "function handleDelete");

  it("reactivate retries with force after a would-fire-immediately 409 confirmation", () => {
    expect(handler).toMatch(/confirmed: ArmRefusalCode \| null = null/);
    expect(handler).toMatch(/const force = confirmed !== null;/);
    expect(handler).toMatch(/body:\s*JSON\.stringify\(\{ id, action: "reactivate", force \}\)/);
    expect(handler).toMatch(/result\.status\s*===\s*409/);
    expect(handler).toContain('"would_fire_immediately"');
    expect(handler).toMatch(/is already past this level/);
    expect(handler).toMatch(/handleReactivate\(id,\s*"would_fire_immediately"\)/);
  });

  it("an out-of-range refusal gets its own confirm-and-retry, with formatted prices", () => {
    const branch = sliceBetween(handler, 'code === "beyond_scan_range"', "Couldn't reactivate the level");
    // The confirm is the app's ConfirmDialog (setConfirmPrompt), not the
    // browser's native confirm().
    expect(branch).toMatch(/setConfirmPrompt\(/);
    expect(branch).toMatch(/outside the scanner's range/);
    expect(branch).toMatch(/handleReactivate\(id,\s*"beyond_scan_range"\)/);
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

  it("a forced out-of-range re-arm says it will not alert; the next-scan promise is for the would-fire case only", () => {
    const success = sliceBetween(handler, "if (result.ok) {", "} else if (result.status === 409");
    const beyond = anchorIndex(success, 'confirmed === "beyond_scan_range"');
    const today = anchorIndex(success, "} else if (alertedToday) {");
    const wouldFire = anchorIndex(success, 'confirmed === "would_fire_immediately"');
    // Out-of-range is decided before either "it will alert" message.
    expect(beyond).toBeLessThan(today);
    expect(today).toBeLessThan(wouldFire);
    expect(success.slice(beyond, today)).toContain(
      "Active again, but outside the scanner's range, so it will not alert."
    );
    expect(success.slice(beyond, today)).not.toContain("next scan");
    expect(success.slice(wouldFire)).toContain("it will alert on the next scan");
    expect(success.split("next scan").length - 1).toBe(1);
  });

  it("the last-fired date is the Eastern date from the shared helper, not a UTC slice", () => {
    const copy = sliceBetween(src, "function lastFiredCopy(", "const LEVEL_TYPE_OPTIONS");
    expect(copy).toMatch(/lastFiredDateET\(l\.triggered_at\) \?\? "an unrecorded date"/);
    expect(copy).not.toMatch(/\.slice\(0,\s*10\)/);
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
    expect(src).toMatch(/const \{ unarmedReview, showPause, showReactivate, showRequeue, showRejectedChip \}\s*=\s*levelActionVisibility\(l\)/);
    expect(src).toMatch(/const \{ showPause, showReactivate, showRequeue, showRejectedChip \}\s*=\s*levelActionVisibility\(l\)/);
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
