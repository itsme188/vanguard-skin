import { describe, it, expect, vi } from "vitest";
import { resolveAtmContracts } from "@/lib/ibkr/option-chain";
import { parseSnapshotRow } from "@/lib/ibkr/market-data";

const CFG = {} as never; // config is opaque to the resolver; requests are injected

function respondJson(json: unknown) {
  return new Response(JSON.stringify(json), { status: 200 });
}

// Fake secdef surfaces: search (cache warmer), strikes for the month, info per
// right with maturityDates.
function fakeRequest(overrides: Partial<Record<string, unknown>> = {}) {
  return vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
    if (path.includes("secdef/search")) {
      return respondJson([{ sections: [{ secType: "OPT", months: "JUL26;AUG26" }] }]);
    }
    if (path.includes("secdef/strikes")) {
      return respondJson(overrides.strikes ?? { call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
    }
    if (path.includes("secdef/info")) {
      return respondJson(
        overrides.info ?? [
          { conid: query.right === "C" ? 9001 : 9002, maturityDate: "20260714" },
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ],
      );
    }
    throw new Error(`unexpected path ${path}`);
  });
}

describe("resolveAtmContracts", () => {
  it("picks ATM strike and the first strictly-post-print expiry (AMC)", async () => {
    const request = fakeRequest();
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never });
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
  });

  it("null when no eligible expiry within 21 days", async () => {
    const request = fakeRequest({
      info: [{ conid: 9001, maturityDate: "20260910" }],
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never });
    expect(out).toBeNull();
  });

  it("null on empty strikes / request failure", async () => {
    const request = vi.fn(async () => respondJson({ call: [], put: [] }));
    expect(await resolveAtmContracts(CFG, "lst", {
      conid: 1, symbol: "X", eventDate: "2026-07-14", eventTime: "AMC", spot: 100,
    }, { request: request as never, delayMs: 0 })).toBeNull();

    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect(await resolveAtmContracts(CFG, "lst", {
      conid: 1, symbol: "X", eventDate: "2026-07-14", eventTime: "AMC", spot: 100,
    }, { request: failing as never, delayMs: 0 })).toBeNull();
  });

  it("retries a cold-cache empty strikes response before giving up on a month (probe warm-up quirk)", async () => {
    let strikesCalls = 0;
    const request = vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
      if (path.includes("secdef/strikes")) {
        strikesCalls++;
        // First call(s) return the cold-cache empty shape; a later call is populated.
        if (strikesCalls < 2) return respondJson({ call: [], put: [] });
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        return respondJson([
          { conid: query.right === "C" ? 9001 : 9002, maturityDate: "20260714" },
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });

    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });

    expect(strikesCalls).toBeGreaterThanOrEqual(2);
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
  });

  it("warms the chain cache via secdef/search BEFORE the first strikes call (2026-07-20 probe)", async () => {
    // Live-probed 2026-07-20 (RTH): without a prior /iserver/secdef/search for
    // the underlying, /iserver/secdef/strikes returned {"call":[],"put":[]} on
    // 9+ polls across two months; ONE search call made both months populate on
    // the first poll. Retry-alone is not a reliable warmer.
    const order: string[] = [];
    const request = vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
      if (path.includes("secdef/search")) {
        order.push("search");
        expect(query).toMatchObject({ symbol: "AAPL", secType: "STK" });
        return respondJson([{ sections: [{ secType: "OPT", months: "JUL26" }] }]);
      }
      if (path.includes("secdef/strikes")) {
        order.push("strikes");
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        return respondJson([
          { conid: query.right === "C" ? 9001 : 9002, maturityDate: "20260714" },
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(order[0]).toBe("search");
    expect(order).toContain("strikes");
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
  });

  it("search warm-up failure is non-fatal — resolve proceeds to strikes", async () => {
    const request = vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
      if (path.includes("secdef/search")) throw new Error("search down");
      if (path.includes("secdef/strikes")) {
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        return respondJson([
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
  });

  it("fetches C and P secdef/info concurrently (not sequential awaits)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const request = vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
      if (path.includes("secdef/search")) {
        return respondJson([{ sections: [{ secType: "OPT", months: "JUL26" }] }]);
      }
      if (path.includes("secdef/strikes")) {
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return respondJson([
          { conid: query.right === "C" ? 9003 : 9004, maturityDate: "20260718" },
        ]);
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(out).toEqual({ callConid: 9003, putConid: 9004, expiry: "2026-07-18", strike: 130 });
    expect(maxInFlight).toBe(2);
  });

  it("null when /secdef/info returns non-ok status", async () => {
    const request = vi.fn(async (_cfg, _lst, _m, path: string) => {
      if (path.includes("secdef/strikes")) {
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        return new Response("error", { status: 500 });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(out).toBeNull();
  });

  it("null when /secdef/info returns non-array body", async () => {
    const request = vi.fn(async (_cfg, _lst, _m, path: string) => {
      if (path.includes("secdef/strikes")) {
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        return respondJson({ error: "invalid request" });
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(out).toBeNull();
  });

  it("null when call/put expiries are disjoint (no shared expiry)", async () => {
    const request = vi.fn(async (_cfg, _lst, _m, path: string, query: Record<string, string>) => {
      if (path.includes("secdef/strikes")) {
        return respondJson({ call: [120, 125, 130, 135], put: [120, 125, 130, 135] });
      }
      if (path.includes("secdef/info")) {
        // Calls: only 20260718 expiry; Puts: only 20260719 expiry. No intersection.
        if (query.right === "C") {
          return respondJson([{ conid: 9001, maturityDate: "20260718" }]);
        }
        return respondJson([{ conid: 9002, maturityDate: "20260719" }]);
      }
      throw new Error(`unexpected path ${path}`);
    });
    const out = await resolveAtmContracts(CFG, "lst", {
      conid: 265598, symbol: "AAPL", eventDate: "2026-07-14", eventTime: "AMC", spot: 128.9,
    }, { request: request as never, delayMs: 0 });
    expect(out).toBeNull();
  });
});

describe("parseSnapshotRow bid/ask", () => {
  it("parses probed bid/ask codes; absent → null", () => {
    // Replace "84"/"86" with the probe-verified codes if they differ.
    const q = parseSnapshotRow({ conid: 9003, "31": "3.20", "84": "3.00", "86": "3.40" });
    expect(q.bid).toBeCloseTo(3.0);
    expect(q.ask).toBeCloseTo(3.4);
    expect(parseSnapshotRow({ conid: 9003, "31": "3.20" }).bid).toBeNull();
  });
});
