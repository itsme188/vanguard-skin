import { describe, it, expect } from "vitest";
import {
  levelRowStatus,
  levelStatusRank,
  hiddenLevelsSummary,
  levelRowMeta,
} from "@/app/dashboard/components/LevelsPanel";
import { compareValues } from "@/lib/hooks/useSortParam";

type Row = Parameters<typeof levelRowStatus>[0];

const ARMED: Row = { is_active: 1, review_status: "auto_approved", triggered_at: null };
const REARMED: Row = { is_active: 1, review_status: "auto_approved", triggered_at: "2026-09-01 14:00:00" };
const PENDING: Row = { is_active: 1, review_status: "pending_review", triggered_at: null };
const REJECTED: Row = { is_active: 1, review_status: "rejected", triggered_at: null };
const FIRED: Row = { is_active: 0, review_status: "auto_approved", triggered_at: "2026-09-01 14:00:00" };
const PAUSED: Row = { is_active: 0, review_status: "auto_approved", triggered_at: null };
const PAUSED_REJECTED: Row = { is_active: 0, review_status: "rejected", triggered_at: null };

describe("levelRowStatus — the status a row's chips show", () => {
  it("names each visible status", () => {
    expect(levelRowStatus(ARMED)).toBe("armed");
    // A re-armed level keeps its last-fired chip but is watched again.
    expect(levelRowStatus(REARMED)).toBe("armed");
    expect(levelRowStatus(PENDING)).toBe("pending_review");
    expect(levelRowStatus(REJECTED)).toBe("rejected");
    expect(levelRowStatus(FIRED)).toBe("triggered");
    expect(levelRowStatus(PAUSED)).toBe("inactive");
    // A paused rejected row is still rejected (its row also carries the
    // inactive chip), so it sorts and counts with the rejected ones.
    expect(levelRowStatus(PAUSED_REJECTED)).toBe("rejected");
  });
});

// QA finding security-detail-levels--status-sort-pill-orders-by-is-active-not-
// visible-status: REJECTED and PENDING REVIEW rows both have is_active = 1, so
// sorting on the flag left them interleaved.
describe("Status sort groups rows by visible status", () => {
  const shuffled = [REJECTED, PENDING, FIRED, REJECTED, ARMED, PENDING, PAUSED, REJECTED, ARMED];

  it("sorting on is_active leaves rejected and pending interleaved (the defect)", () => {
    const byFlag = [...shuffled].sort((a, b) => compareValues(a.is_active, b.is_active, "desc"));
    expect(byFlag.slice(0, 4).map(levelRowStatus)).toEqual([
      "rejected",
      "pending_review",
      "rejected",
      "armed",
    ]);
  });

  it("sorting on the status rank groups them: armed, fired, pending, rejected, inactive", () => {
    const sorted = [...shuffled].sort((a, b) =>
      compareValues(levelStatusRank(a), levelStatusRank(b), "desc"),
    );
    expect(sorted.map(levelRowStatus)).toEqual([
      "armed",
      "armed",
      "triggered",
      "pending_review",
      "pending_review",
      "rejected",
      "rejected",
      "rejected",
      "inactive",
    ]);
    const reversed = [...shuffled].sort((a, b) =>
      compareValues(levelStatusRank(a), levelStatusRank(b), "asc"),
    );
    expect(reversed.map(levelRowStatus)).toEqual([...sorted.map(levelRowStatus)].reverse());
  });
});

// QA finding security-detail-levels--empty-state-hides-inactive-and-pending-
// review-levels: "No active levels" over rows that exist in other states.
describe("a paused rejected row", () => {
  it("ranks with the rejected rows and sorts after the pending ones", () => {
    expect(levelStatusRank(PAUSED_REJECTED)).toBe(levelStatusRank(REJECTED));
    expect(levelStatusRank(PAUSED_REJECTED)).toBeGreaterThan(levelStatusRank(PAUSED));
    expect(levelStatusRank(PAUSED_REJECTED)).toBeLessThan(levelStatusRank(PENDING));
  });

  it("is counted as rejected in the hidden summary", () => {
    expect(hiddenLevelsSummary([PAUSED_REJECTED, REJECTED, PAUSED])).toBe(
      "3 not shown: 2 rejected, 1 inactive",
    );
  });
});

describe("hiddenLevelsSummary — what the armed-only view leaves out", () => {
  it("counts hidden rows by status, pending review first", () => {
    expect(hiddenLevelsSummary([REJECTED, FIRED, PENDING, REJECTED, PAUSED, FIRED, REJECTED])).toBe(
      "7 not shown: 1 pending review, 3 rejected, 2 fired, 1 inactive",
    );
  });

  it("leaves out statuses with no rows and never counts an armed row", () => {
    expect(hiddenLevelsSummary([ARMED, REARMED, PENDING])).toBe("1 not shown: 1 pending review");
  });

  it("is null when nothing is hidden", () => {
    expect(hiddenLevelsSummary([])).toBeNull();
    expect(hiddenLevelsSummary([ARMED])).toBeNull();
  });
});

// QA findings security-detail-levels--rows-show-no-date-duplicate-
// contradictory-levels (owner ruling 2026-08-31, option 1) and
// security-detail-levels--expiry-and-timeframe-write-only-no-edit-control
// (display half).
describe("levelRowMeta — added date, timeframe and expiry on every row", () => {
  const TODAY = "2026-10-07";

  it("shows the Eastern date a level was added, not the UTC date", () => {
    // 01:30 UTC on the 2nd is 9:30pm Eastern on the 1st.
    expect(levelRowMeta({ created_at: "2026-09-02 01:30:00", timeframe: null, expires_at: null }, TODAY)).toEqual([
      "Added 2026-09-01",
    ]);
    expect(levelRowMeta({ created_at: "2026-09-02 15:30:00", timeframe: null, expires_at: null }, TODAY)).toEqual([
      "Added 2026-09-02",
    ]);
  });

  it("shows the timeframe and a future expiry", () => {
    expect(
      levelRowMeta({ created_at: "2026-09-02 15:30:00", timeframe: "week", expires_at: "2026-10-31" }, TODAY),
    ).toEqual(["Added 2026-09-02", "Timeframe week", "Expires 2026-10-31"]);
  });

  it("an expiry of today still reads Expires; a past one reads Expired", () => {
    const base = { created_at: "2026-09-02 15:30:00", timeframe: null };
    expect(levelRowMeta({ ...base, expires_at: TODAY }, TODAY)).toContain("Expires 2026-10-07");
    expect(levelRowMeta({ ...base, expires_at: "2026-09-30" }, TODAY)).toContain("Expired 2026-09-30");
  });

  it("leaves out an unreadable created_at instead of printing it", () => {
    expect(levelRowMeta({ created_at: "", timeframe: null, expires_at: null }, TODAY)).toEqual([]);
  });
});
