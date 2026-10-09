import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideDigestBanner } from "@/lib/digest/catchup-banner";
import { anchorIndex } from "@/tests/helpers/source-anchor";

/**
 * The catch-up banner used to say "Today's digest wasn't sent at 8:45 AM" and
 * offer Send now on a morning when the scheduled run had looked and found
 * nothing new. Send now then skipped for the same reason. The scheduled run
 * now records that skip, and the banner reads it.
 */

// A weekday morning; the scheduled time and the clock are built the same way
// the component builds them, so the test does not depend on the machine zone.
const scheduled = new Date(2026, 9, 8, 8, 45, 0, 0);
const after = (minutes: number) => new Date(scheduled.getTime() + minutes * 60_000);
const TODAY = "2026-10-08";

const base = {
  now: after(30),
  scheduled,
  today: TODAY,
  lastDigestSentAt: new Date(2026, 9, 7, 8, 47).toISOString(),
  cloudVia: null,
  cloudPresent: false,
  lastDigestSkip: null,
} as const;

describe("decideDigestBanner", () => {
  it("says nothing before the scheduled time", () => {
    expect(decideDigestBanner({ ...base, now: after(-5) })).toBe("hidden");
  });

  it("no send and no recorded skip: the digest really was missed", () => {
    expect(decideDigestBanner(base)).toBe("not-sent");
    expect(decideDigestBanner({ ...base, lastDigestSentAt: null })).toBe("not-sent");
  });

  it("the scheduled run skipped today for an empty window: explain, do not nag", () => {
    expect(
      decideDigestBanner({
        ...base,
        lastDigestSkip: { reason: "No processed articles in the selected range", date: TODAY, at: after(2).toISOString() },
      }),
    ).toBe("skipped-empty");
  });

  it("a skip recorded on an earlier day says nothing about today", () => {
    expect(
      decideDigestBanner({
        ...base,
        lastDigestSkip: { reason: "No processed articles in the selected range", date: "2026-10-07", at: after(-1438).toISOString() },
      }),
    ).toBe("not-sent");
  });

  it("a skip recorded today but before the scheduled time is not the scheduled run", () => {
    expect(
      decideDigestBanner({
        ...base,
        lastDigestSkip: { reason: "No processed articles in the selected range", date: TODAY, at: after(-90).toISOString() },
      }),
    ).toBe("not-sent");
  });

  it("a digest sent after the scheduled time wins over an earlier skip", () => {
    expect(
      decideDigestBanner({
        ...base,
        lastDigestSentAt: after(20).toISOString(),
        lastDigestSkip: { reason: "No processed articles in the selected range", date: TODAY, at: after(2).toISOString() },
      }),
    ).toBe("hidden");
  });

  it("cloud states keep their precedence", () => {
    const skip = { reason: "No processed articles in the selected range", date: TODAY, at: after(2).toISOString() };
    expect(decideDigestBanner({ ...base, cloudPresent: true, cloudVia: "attempting", lastDigestSkip: skip })).toBe("cloud-sending");
    expect(decideDigestBanner({ ...base, cloudPresent: true, cloudVia: "sent" })).toBe("hidden");
    expect(decideDigestBanner({ ...base, cloudPresent: true, cloudVia: null })).toBe("hidden");
  });

  it("an unreadable skip timestamp falls back to the missed-digest banner", () => {
    expect(
      decideDigestBanner({ ...base, lastDigestSkip: { reason: "x", date: TODAY, at: "not a time" } }),
    ).toBe("not-sent");
  });
});

describe("DigestCatchup renders the skipped state", () => {
  const src = readFileSync(join(process.cwd(), "app/dashboard/components/DigestCatchup.tsx"), "utf8");

  it("decides through the shared helper, reading the recorded skip", () => {
    expect(src).toContain("decideDigestBanner(");
    expect(src).toContain("data.lastDigestSkip");
  });

  it("offers no Send button when there was nothing to send", () => {
    const at = anchorIndex(src, "onClick={handleSend}");
    const guard = src.slice(at - 200, at);
    expect(guard).toContain("!skippedEmpty");
  });

  it("explains the skip in plain words", () => {
    expect(src).toContain("there was nothing new to send");
  });
});
