/**
 * Packaged-app trust boundary (#35, task 4) — service-auth consolidation.
 *
 * Covers the 4 routes that used to re-implement the cron-secret check with
 * a plain `!==` returning 403 (a divergent dialect from the other 6
 * `/api/cron/*` routes, which already used `withCronAuth`'s constant-time
 * compare: 500 on missing secret, 401 on mismatch). All 4 are now wrapped
 * in `lib/cron/wrappers.ts::withCronAuth`:
 *
 *   - POST /api/calendar/enrich
 *   - POST /api/calendar/reconcile-cloud-enrich
 *   - POST /api/levels/reconcile-cloud-fired
 *   - POST /api/research/reconcile-cloud-fetched
 *
 * Also covers the calendar/enrich split: POST /api/calendar/enrich-manual
 * is the new human-callable path with the SAME enrichment behavior but no
 * cron-secret requirement (lib/calendar/enrich-request.ts::runCalendarEnrichRequest
 * is the shared entrypoint both routes call).
 *
 * Underlying lib calls are mocked throughout — no real network/AI/DB work.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  getIbApi: vi.fn(() => null),
  runCalendarEnrichRequest: vi.fn(async () => ({
    ok: true as const,
    enriched: 1,
    failed: 0,
    total: 1,
    events: [{ id: 1, actual: "3.2%", reaction_present: true }],
  })),
  reconcileCloudEnrichment: vi.fn(async () => ({
    ok: true,
    reconciled: 2,
    skipped_tws_wins: 0,
    skipped_deferred: 0,
  })),
  reconcileCloudFiredLevels: vi.fn(async () => ({
    ok: true,
    reconciled: 3,
    skipped_already_alerted: 0,
    skipped_level_missing: 0,
  })),
  reconcileCloudFetchedNewsletters: vi.fn(async () => ({
    ok: true,
    reconciled: 4,
    skipped_already_in_db: 0,
    skipped_source_missing: 0,
  })),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/tws/client", () => ({
  getIbApi: hoisted.getIbApi,
}));

vi.mock("@/lib/calendar/enrich-request", () => ({
  runCalendarEnrichRequest: hoisted.runCalendarEnrichRequest,
}));

vi.mock("@/lib/calendar/cloud-reconcile", () => ({
  reconcileCloudEnrichment: hoisted.reconcileCloudEnrichment,
}));

vi.mock("@/lib/alerts/reconcile-cloud-fired", () => ({
  reconcileCloudFiredLevels: hoisted.reconcileCloudFiredLevels,
}));

vi.mock("@/lib/research/reconcile-cloud-fetched", () => ({
  reconcileCloudFetchedNewsletters: hoisted.reconcileCloudFetchedNewsletters,
}));

import { POST as enrichPost } from "@/app/api/calendar/enrich/route";
import { POST as enrichManualPost } from "@/app/api/calendar/enrich-manual/route";
import { POST as reconcileEnrichPost } from "@/app/api/calendar/reconcile-cloud-enrich/route";
import { POST as reconcileFiredPost } from "@/app/api/levels/reconcile-cloud-fired/route";
import { POST as reconcileFetchedPost } from "@/app/api/research/reconcile-cloud-fetched/route";

function makeRequest(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV, CRON_SHARED_SECRET: "test-secret" };
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe.each([
  {
    name: "POST /api/calendar/enrich",
    url: "/api/calendar/enrich",
    post: enrichPost,
    mock: hoisted.runCalendarEnrichRequest,
    successField: "ok",
  },
  {
    name: "POST /api/calendar/reconcile-cloud-enrich",
    url: "/api/calendar/reconcile-cloud-enrich",
    post: reconcileEnrichPost,
    mock: hoisted.reconcileCloudEnrichment,
    successField: "ok",
  },
  {
    name: "POST /api/levels/reconcile-cloud-fired",
    url: "/api/levels/reconcile-cloud-fired",
    post: reconcileFiredPost,
    mock: hoisted.reconcileCloudFiredLevels,
    successField: "ok",
  },
  {
    name: "POST /api/research/reconcile-cloud-fetched",
    url: "/api/research/reconcile-cloud-fetched",
    post: reconcileFetchedPost,
    mock: hoisted.reconcileCloudFetchedNewsletters,
    successField: "ok",
  },
])("$name (withCronAuth)", ({ url, post, mock, successField }) => {
  it("returns 500 when CRON_SHARED_SECRET is missing", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await post(makeRequest(url, { "x-cron-secret": "anything" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Cron-Secret is wrong", async () => {
    const res = await post(makeRequest(url, { "x-cron-secret": "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(mock).not.toHaveBeenCalled();
  });

  it("returns 401 when X-Cron-Secret is missing entirely", async () => {
    const res = await post(makeRequest(url));
    expect(res.status).toBe(401);
    expect(mock).not.toHaveBeenCalled();
  });

  it("runs the handler when X-Cron-Secret matches", async () => {
    const res = await post(makeRequest(url, { "x-cron-secret": "test-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[successField]).toBe(true);
    expect(mock).toHaveBeenCalledOnce();
  });
});

describe("POST /api/calendar/enrich-manual (human path)", () => {
  it("runs without any X-Cron-Secret header", async () => {
    const res = await enrichManualPost(makeRequest("/api/calendar/enrich-manual"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(hoisted.runCalendarEnrichRequest).toHaveBeenCalledOnce();
  });

  it("runs even when CRON_SHARED_SECRET is unset server-side", async () => {
    delete process.env.CRON_SHARED_SECRET;
    const res = await enrichManualPost(makeRequest("/api/calendar/enrich-manual"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("passes eventId/upgradeReactionToTws through to the shared entrypoint", async () => {
    const req = new NextRequest("http://localhost/api/calendar/enrich-manual", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: 42, upgradeReactionToTws: true }),
    });
    await enrichManualPost(req);
    expect(hoisted.runCalendarEnrichRequest).toHaveBeenCalledWith(
      hoisted.db,
      expect.objectContaining({ eventId: 42, upgradeReactionToTws: true }),
    );
  });
});
