/**
 * Tests for the marker-deduped push-at-print sender.
 *
 * Strategy: mock sendPushover + the earnings-marker-check helpers so we can
 * verify the dedup + fire + write-marker sequencing without any network I/O.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/alerts/notify-pushover", () => ({
  sendPushover: vi.fn(),
}));

vi.mock("@/lib/cron/earnings-marker-check", () => ({
  checkPrintPushMarker: vi.fn(),
  writePrintPushMarker: vi.fn(),
}));

import { sendPushover } from "@/lib/alerts/notify-pushover";
import {
  checkPrintPushMarker,
  writePrintPushMarker,
} from "@/lib/cron/earnings-marker-check";
import { sendEarningsPrintPush } from "@/lib/alerts/print-push";

const mockSendPushover = vi.mocked(sendPushover);
const mockCheckMarker = vi.mocked(checkPrintPushMarker);
const mockWriteMarker = vi.mocked(writePrintPushMarker);

const baseInput = {
  eventId: 42,
  symbol: "TER",
  actualValue: "EPS 1.42 · Rev 775,200,000",
  consensusValue: "EPS 1.35 · Rev 762,000,000",
  reactionJson: null,
};

describe("sendEarningsPrintPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marker says already pushed → skips sendPushover", async () => {
    mockCheckMarker.mockResolvedValue(true);

    const result = await sendEarningsPrintPush(baseInput);

    expect(mockSendPushover).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: false, reason: "already_pushed" });
  });

  it("marker clear + push sent → fires sendPushover once and writes the marker", async () => {
    mockCheckMarker.mockResolvedValue(false);
    mockSendPushover.mockResolvedValue({ sent: true, requestId: "abc123" });

    const result = await sendEarningsPrintPush(baseInput);

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    expect(mockWriteMarker).toHaveBeenCalledWith(42);
    expect(result).toEqual({ pushed: true });
  });

  it("pushover not configured → no marker write, pushed:false", async () => {
    mockCheckMarker.mockResolvedValue(false);
    mockSendPushover.mockResolvedValue({
      sent: false,
      reason: "pushover_not_configured",
    });

    const result = await sendEarningsPrintPush(baseInput);

    expect(mockSendPushover).toHaveBeenCalledTimes(1);
    expect(mockWriteMarker).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: false, reason: "pushover_not_configured" });
  });
});
