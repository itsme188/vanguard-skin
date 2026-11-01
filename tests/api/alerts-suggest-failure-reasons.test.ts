import { describe, it, expect, vi, beforeEach } from "vitest";

const detailed = vi.fn();
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/alerts/generate-suggestion", () => ({
  generateSuggestionForAlertDetailed: (...a: unknown[]) => detailed(...a),
  claimRegenerateSlot: vi.fn(),
  regenerateSuggestionForAlert: vi.fn(),
  releaseRegenerateSlot: vi.fn(),
  generateSuggestionsForPendingAlerts: vi.fn(),
}));

import { POST } from "@/app/api/alerts/suggest/route";
import { NextRequest } from "next/server";

function req() {
  return new NextRequest("http://localhost/api/alerts/suggest", {
    method: "POST",
    body: JSON.stringify({ alertId: 7 }),
  });
}

beforeEach(() => detailed.mockReset());

describe("POST /api/alerts/suggest alertId branch", () => {
  it.each([
    ["not_found", 404, "Alert not found"],
    ["ai_account", 503, "The AI account cannot answer right now (billing)."],
    ["ai_not_configured", 503, "AI suggestions are not configured on this machine."],
    ["generation_failed", 502, "The AI request failed. Try again in a moment."],
    ["no_context", 502, "No level details."],
  ])("%s -> %i with its own sentence and reason", async (reason, status, message) => {
    detailed.mockResolvedValue({ ok: false, reason, message });
    const res = await POST(req());
    const body = await res.json();
    expect(res.status).toBe(status);
    expect(body).toEqual({ success: false, error: message, reason });
  });

  it("success returns the suggestion", async () => {
    detailed.mockResolvedValue({ ok: true, suggestion: "Hold." });
    const res = await POST(req());
    expect(await res.json()).toEqual({ success: true, suggestion: "Hold." });
  });
});
