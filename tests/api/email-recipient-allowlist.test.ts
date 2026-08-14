/**
 * Coverage for the email-route recipient allowlist + send rate limit
 * (#35 §G, "packaged-app-trust-boundary" — task 21).
 *
 * `/api/digest/email`, `/api/earnings/email`, and `/api/calendar/email`
 * accept a caller-supplied `to` and send from the verified domain via
 * Resend. This is route-level hardening independent of the auth layer:
 * a caller-supplied `to` outside the configured allowlist (BRIEFING_EMAIL_TO
 * env var / settings-backed recipient list) is rejected unless a deliberate
 * `override: true` is also passed, and each route's sends are bounded by a
 * fixed-window rate limit.
 *
 * The route handlers are thin wrappers (CLAUDE.md API pattern: "Route =
 * auth + parse + call") — the composer functions they call
 * (`sendDigestEmail` / `sendBriefingEmail` / `sendEarningsPreview` /
 * `sendEarningsRecap`) already have their own coverage elsewhere and
 * internally call Resend + Claude. Mocking those composer functions here
 * means the guard tests never touch real Resend or real AI calls, and lets
 * each assertion check exactly what the route passed through ("called with
 * the right recipient") without paying for TWS/Gmail/Claude setup.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { resetEmailSendRateLimits } from "@/lib/email/recipient-guard";

// ── Shared mock — replace the `db` singleton with an in-memory DB ──────────

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  sendDigestEmail: vi.fn(),
  sendBriefingEmail: vi.fn(),
  sendEarningsPreview: vi.fn(),
  sendEarningsRecap: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/digest/send-digest", () => ({
  sendDigestEmail: hoisted.sendDigestEmail,
  DigestSendError: class DigestSendError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = "DigestSendError";
    }
  },
}));

vi.mock("@/lib/digest/send-briefing", () => ({
  sendBriefingEmail: hoisted.sendBriefingEmail,
  BriefingSendError: class BriefingSendError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
      this.name = "BriefingSendError";
    }
  },
}));

vi.mock("@/lib/digest/send-earnings-email", () => ({
  sendEarningsPreview: hoisted.sendEarningsPreview,
  sendEarningsRecap: hoisted.sendEarningsRecap,
  EarningsEmailError: class EarningsEmailError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.name = "EarningsEmailError";
    }
  },
}));

// Import AFTER mocks are registered so the routes bind to the mocks.
import { POST as digestEmailPOST } from "@/app/api/digest/email/route";
import { POST as earningsEmailPOST } from "@/app/api/earnings/email/route";
import { POST as calendarEmailPOST } from "@/app/api/calendar/email/route";

const CONFIGURED_TO = "owner@example.com";
const OUTSIDE_TO = "stranger@evil.example.com";

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);

  process.env.BRIEFING_EMAIL_TO = CONFIGURED_TO;

  hoisted.sendDigestEmail.mockReset().mockResolvedValue({
    success: true,
    sentTo: CONFIGURED_TO,
    synced: { fetched: 0, processed: 0 },
    title: "Digest",
    twsSynced: false,
  });
  hoisted.sendBriefingEmail.mockReset().mockResolvedValue({
    success: true,
    weekOf: "2026-08-10",
    sentTo: CONFIGURED_TO,
    generated: false,
    eventCount: 1,
    twsSynced: false,
  });
  hoisted.sendEarningsPreview.mockReset().mockResolvedValue({
    success: true,
    eventId: 1,
    symbol: "AAPL",
    phase: "preview",
    sentTo: CONFIGURED_TO,
    title: "AAPL Preview",
    modelOutputChars: 10,
  });
  hoisted.sendEarningsRecap.mockReset().mockResolvedValue({
    success: true,
    eventId: 1,
    symbol: "AAPL",
    phase: "recap",
    sentTo: CONFIGURED_TO,
    title: "AAPL Recap",
    modelOutputChars: 10,
  });

  resetEmailSendRateLimits();
});

// ── Route table for the parameterized coverage ──────────────────────────────

interface RouteCase {
  name: string;
  call: (body: Record<string, unknown>) => Promise<Response>;
  mockFn: () => ReturnType<typeof vi.fn>;
  baseBody: Record<string, unknown>;
  /** Pull the `to`/recipient the mocked composer was actually invoked with. */
  sentRecipient: (callArgs: unknown[]) => string | undefined;
}

const routeCases: RouteCase[] = [
  {
    name: "POST /api/digest/email",
    call: (body) => digestEmailPOST(jsonRequest("http://localhost/api/digest/email", body)),
    mockFn: () => hoisted.sendDigestEmail,
    baseBody: {},
    sentRecipient: (args) => (args[1] as { recipient?: string })?.recipient,
  },
  {
    name: "POST /api/calendar/email",
    call: (body) => calendarEmailPOST(jsonRequest("http://localhost/api/calendar/email", body)),
    mockFn: () => hoisted.sendBriefingEmail,
    baseBody: {},
    sentRecipient: (args) => (args[1] as { recipient?: string })?.recipient,
  },
  {
    name: "POST /api/earnings/email (preview)",
    call: (body) =>
      earningsEmailPOST(
        jsonRequest("http://localhost/api/earnings/email", { eventId: 1, phase: "preview", ...body }),
      ),
    mockFn: () => hoisted.sendEarningsPreview,
    baseBody: { eventId: 1, phase: "preview" },
    // sendEarningsPreview(db, eventId, opts)
    sentRecipient: (args) => (args[2] as { recipient?: string })?.recipient,
  },
];

describe.each(routeCases)("$name — recipient allowlist + rate limit", (rc) => {
  it("allows the configured (allowlisted) recipient and calls send with it", async () => {
    const res = await rc.call({ ...rc.baseBody, to: CONFIGURED_TO });
    expect(res.status).toBe(200);
    expect(rc.mockFn()).toHaveBeenCalledTimes(1);
    expect(rc.sentRecipient(rc.mockFn().mock.calls[0])).toBe(CONFIGURED_TO);
  });

  it("allows the default path (no `to` at all) without touching the allowlist", async () => {
    const res = await rc.call({ ...rc.baseBody });
    expect(res.status).toBe(200);
    expect(rc.mockFn()).toHaveBeenCalledTimes(1);
    expect(rc.sentRecipient(rc.mockFn().mock.calls[0])).toBeUndefined();
  });

  it("rejects a non-allowlisted `to` with 400 and never calls send", async () => {
    const res = await rc.call({ ...rc.baseBody, to: OUTSIDE_TO });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/allowlist/i);
    expect(rc.mockFn()).not.toHaveBeenCalled();
  });

  it("allows a non-allowlisted `to` when override: true is passed", async () => {
    const res = await rc.call({ ...rc.baseBody, to: OUTSIDE_TO, override: true });
    expect(res.status).toBe(200);
    expect(rc.mockFn()).toHaveBeenCalledTimes(1);
    expect(rc.sentRecipient(rc.mockFn().mock.calls[0])).toBe(OUTSIDE_TO);
  });

  it("rate-limits sends: after 5 allowed sends, the 6th is rejected with 429 and send is not called", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await rc.call({ ...rc.baseBody, to: CONFIGURED_TO });
      expect(res.status).toBe(200);
    }
    expect(rc.mockFn()).toHaveBeenCalledTimes(5);

    const res = await rc.call({ ...rc.baseBody, to: CONFIGURED_TO });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too many/i);
    // Still only 5 — the 6th request never reached the composer.
    expect(rc.mockFn()).toHaveBeenCalledTimes(5);
  });
});

// ── Settings-backed override coverage (digest + calendar only — earnings has none) ──

describe("recipient allowlist honors settings-backed recipient overrides", () => {
  it("digest route allows a `to` matching digest_email_recipients even when it differs from BRIEFING_EMAIL_TO", async () => {
    const settingsRecipient = "digest-only@example.com";
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("digest_email_recipients", settingsRecipient);

    const res = await digestEmailPOST(
      jsonRequest("http://localhost/api/digest/email", { to: settingsRecipient }),
    );
    expect(res.status).toBe(200);
    expect(hoisted.sendDigestEmail).toHaveBeenCalledTimes(1);
  });

  it("calendar route allows a `to` matching briefing_email_recipients even when it differs from BRIEFING_EMAIL_TO", async () => {
    const settingsRecipient = "briefing-only@example.com";
    hoisted.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run("briefing_email_recipients", settingsRecipient);

    const res = await calendarEmailPOST(
      jsonRequest("http://localhost/api/calendar/email", { to: settingsRecipient }),
    );
    expect(res.status).toBe(200);
    expect(hoisted.sendBriefingEmail).toHaveBeenCalledTimes(1);
  });
});

// ── Review round 1: mixed-recipient, case-normalization, non-string `to` ──
//
// The multi-recipient split (`disallowed.filter`) and the lowercase
// normalization (`parseAddresses`) were already implemented but untested —
// this closes that gap. The non-string `to` case covers a JSON request body
// where `to` deserializes to something other than a string (an array here);
// pre-fix that value reached `.trim()` inside `checkRecipientAllowed` and
// threw past the route's try/catch instead of failing closed with a clean
// 400. Exercised on the digest route only — the guard is single-sourced in
// `lib/email/recipient-guard.ts`, so this isn't route-specific behavior.

describe("recipient allowlist — mixed recipients, case normalization, non-string `to`", () => {
  it("rejects a mixed `to` (one allowlisted + one not) with 400 naming only the bad address", async () => {
    const mixedTo = `${CONFIGURED_TO},${OUTSIDE_TO}`;
    const res = await digestEmailPOST(
      jsonRequest("http://localhost/api/digest/email", { to: mixedTo }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(OUTSIDE_TO);
    expect(body.error).not.toContain(CONFIGURED_TO);
    expect(hoisted.sendDigestEmail).not.toHaveBeenCalled();
  });

  it("allows an allowlisted recipient supplied in a different case", async () => {
    const upperTo = CONFIGURED_TO.toUpperCase();
    const res = await digestEmailPOST(
      jsonRequest("http://localhost/api/digest/email", { to: upperTo }),
    );
    expect(res.status).toBe(200);
    expect(hoisted.sendDigestEmail).toHaveBeenCalledTimes(1);
    // The guard only compares case-insensitively for the allowlist check —
    // it doesn't rewrite what's actually sent, so the composer still
    // receives the caller's original casing.
    expect(
      (hoisted.sendDigestEmail.mock.calls[0][1] as { recipient?: string }).recipient,
    ).toBe(upperTo);
  });

  it("rejects a non-string `to` (JSON array) with a clean 400, not an unhandled exception", async () => {
    const res = await digestEmailPOST(
      jsonRequest("http://localhost/api/digest/email", { to: [CONFIGURED_TO] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
    expect(hoisted.sendDigestEmail).not.toHaveBeenCalled();
  });

  it("a missing `to` still takes the default-allowed path (non-string guard doesn't touch it)", async () => {
    const res = await digestEmailPOST(jsonRequest("http://localhost/api/digest/email", {}));
    expect(res.status).toBe(200);
    expect(hoisted.sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(
      (hoisted.sendDigestEmail.mock.calls[0][1] as { recipient?: string }).recipient,
    ).toBeUndefined();
  });
});
