import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createWithTokenLadder,
  OUTPUT_TOKEN_LADDER,
} from "@/lib/digest/send-earnings-email";

type Resp = { stop_reason: string | null };

describe("createWithTokenLadder (B17b — output-token retry ladder)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("tops out at 16384 — 8192 was not enough for the GOOG 7/22 mega-cap preview", () => {
    expect(OUTPUT_TOKEN_LADDER).toEqual([4096, 8192, 16384]);
  });

  it("returns the first response when output fits the first rung", async () => {
    const create = vi.fn(async (): Promise<Resp> => ({ stop_reason: "end_turn" }));
    const res = await createWithTokenLadder(create, "preview");
    expect(res.stop_reason).toBe("end_turn");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(4096);
  });

  it("escalates through every rung while the model keeps truncating", async () => {
    const create = vi.fn(
      async (max: number): Promise<Resp> =>
        max < 16384 ? { stop_reason: "max_tokens" } : { stop_reason: "end_turn" },
    );
    const res = await createWithTokenLadder(create, "preview");
    expect(res.stop_reason).toBe("end_turn");
    expect(create.mock.calls.map((c) => c[0])).toEqual([4096, 8192, 16384]);
  });

  it("refuses to send when even the top rung truncates", async () => {
    const create = vi.fn(async (): Promise<Resp> => ({ stop_reason: "max_tokens" }));
    await expect(createWithTokenLadder(create, "recap")).rejects.toThrow(
      /truncated even at 16384 tokens/,
    );
    expect(create).toHaveBeenCalledTimes(OUTPUT_TOKEN_LADDER.length);
  });
});
