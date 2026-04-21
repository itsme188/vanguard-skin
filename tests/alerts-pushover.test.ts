import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendPushover, sendLevelAlertPush } from "@/lib/alerts/notify-pushover";

function clearPushoverEnv() {
  delete process.env.PUSHOVER_APP_TOKEN;
  delete process.env.PUSHOVER_USER_KEY;
  delete process.env.PUSHOVER_LINK_BASE;
}

describe("sendPushover", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearPushoverEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPushoverEnv();
  });

  it("skips cleanly when env vars are missing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendPushover({ title: "t", message: "m" });

    expect(res).toEqual({ sent: false, reason: "pushover_not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when only one of the two vars is set", async () => {
    process.env.PUSHOVER_APP_TOKEN = "abc";
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendPushover({ title: "t", message: "m" });

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("pushover_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to the Pushover endpoint when configured", async () => {
    process.env.PUSHOVER_APP_TOKEN = "tok";
    process.env.PUSHOVER_USER_KEY = "usr";

    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-123" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendPushover({
      title: "HOOD ENTRY hit",
      message: "Triggered @ $91.32",
      url: "http://example.com/sec/1",
    });

    expect(res).toEqual({ sent: true, requestId: "req-123" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pushover.net/1/messages.json");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("token")).toBe("tok");
    expect(body.get("user")).toBe("usr");
    expect(body.get("title")).toBe("HOOD ENTRY hit");
    expect(body.get("message")).toBe("Triggered @ $91.32");
    expect(body.get("url")).toBe("http://example.com/sec/1");
  });

  it("reports Pushover API errors without throwing", async () => {
    process.env.PUSHOVER_APP_TOKEN = "tok";
    process.env.PUSHOVER_USER_KEY = "usr";

    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 400,
      json: async () => ({ status: 0, errors: ["invalid user key"] }),
    }) as unknown as typeof fetch;

    const res = await sendPushover({ title: "t", message: "m" });

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("invalid user key");
  });

  it("catches network errors without throwing", async () => {
    process.env.PUSHOVER_APP_TOKEN = "tok";
    process.env.PUSHOVER_USER_KEY = "usr";

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const res = await sendPushover({ title: "t", message: "m" });

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("ECONNREFUSED");
  });
});

describe("sendLevelAlertPush", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearPushoverEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearPushoverEnv();
  });

  it("composes a symbol + price + author message and a deep link", async () => {
    process.env.PUSHOVER_APP_TOKEN = "tok";
    process.env.PUSHOVER_USER_KEY = "usr";
    process.env.PUSHOVER_LINK_BASE = "http://test-host:3099";

    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-999" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendLevelAlertPush({
      symbol: "HOOD",
      levelType: "entry",
      triggeredPrice: 91.32,
      sourceAuthor: "Helene Meisler",
      heldQuantity: 300,
      securityId: 1735,
    });

    expect(res.sent).toBe(true);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("title")).toBe("HOOD ENTRY hit");
    expect(body.get("message")).toBe(
      "Triggered @ $91.32 — Helene Meisler — held 300 sh"
    );
    expect(body.get("url")).toBe(
      "http://test-host:3099/dashboard/security/1735"
    );
  });

  it("omits held-quantity and author when not provided", async () => {
    process.env.PUSHOVER_APP_TOKEN = "tok";
    process.env.PUSHOVER_USER_KEY = "usr";

    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-1" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendLevelAlertPush({
      symbol: "VTI",
      levelType: "support",
      triggeredPrice: 280.5,
      sourceAuthor: null,
      heldQuantity: 0,
      securityId: 42,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("message")).toBe("Triggered @ $280.50");
  });

  it("is a no-op (not thrown) when env vars are missing", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const res = await sendLevelAlertPush({
      symbol: "AAPL",
      levelType: "target",
      triggeredPrice: 210,
      sourceAuthor: null,
      heldQuantity: null,
      securityId: 1,
    });

    expect(res.sent).toBe(false);
    expect(res.reason).toBe("pushover_not_configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
