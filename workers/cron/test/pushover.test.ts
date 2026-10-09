/**
 * Tests for the Worker-side Pushover composer — specifically the
 * armedCrossedAt honest-copy disclosure, mirroring
 * lib/alerts/notify-pushover.ts on the Mac side (see tests/alerts-pushover.test.ts).
 */

import { describe, it, expect, vi } from "vitest";
import { sendLevelAlertPush, type PushoverEnv } from "../src/pushover";

function envWithCreds(): PushoverEnv {
  return { PUSHOVER_APP_TOKEN: "tok", PUSHOVER_USER_KEY: "usr" };
}

describe("sendLevelAlertPush (Worker)", () => {
  it("composes the normal cloud-fired message when armedCrossedAt is absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-1" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendLevelAlertPush(envWithCreds(), {
      symbol: "HOOD",
      levelType: "support",
      triggeredPrice: 91.32,
      sourceAuthor: "Helene Meisler",
      securityId: 1735,
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("message")).toBe("Triggered @ $91.32 — Helene Meisler — cloud-fired");
  });

  it("discloses when the level was already past its threshold when armed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-2" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendLevelAlertPush(envWithCreds(), {
      symbol: "HOOD",
      levelType: "support",
      triggeredPrice: 91.32,
      sourceAuthor: "Helene Meisler",
      securityId: 1735,
      armedCrossedAt: "2026-08-10 12:00:00",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("message")).toBe(
      "Triggered @ $91.32 — was already past this level when it was armed — Helene Meisler — cloud-fired"
    );
  });

  it("labels a non-dollar level in its own currency, with the number unchanged", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-3" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendLevelAlertPush(envWithCreds(), {
      symbol: "ZZJ",
      levelType: "support",
      triggeredPrice: 976000,
      sourceAuthor: null,
      securityId: 7,
      currency: "JPY",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("message")).toBe("Triggered @ \u00a5976,000 \u2014 cloud-fired");
  });

  it("an explicit USD currency reads exactly as a missing one", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ status: 1, request: "req-4" }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendLevelAlertPush(envWithCreds(), {
      symbol: "HOOD",
      levelType: "support",
      triggeredPrice: 1291.3,
      sourceAuthor: null,
      securityId: 1735,
      currency: "USD",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("message")).toBe("Triggered @ $1,291.30 \u2014 cloud-fired");
  });
});
