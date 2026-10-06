/**
 * POST /api/earnings/recap-modal — the "gen recap" generate flow as a
 * Server-Sent Events stream (TODO 2026-08-28 pairing follow-up (1), DECIDED
 * Option 1 in full): per-retry progress, cancellation, and a server cap of
 * 2 TOTAL attempts at the AI step.
 *
 * The composer and the enrichment runner are stubbed, so nothing here can
 * reach an AI provider or a vendor API. Framing mirrors /api/trade-review:
 * `data: <json>\n\n` lines carrying `{progress}`, a terminal
 * `{complete:true,data}` or `{error}`, then `data: [DONE]`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  compose: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock("@/lib/digest/send-earnings-email", () => {
  class EarningsEmailError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return { EarningsEmailError, composeEarningsEmail: hoisted.compose };
});

vi.mock("@/lib/calendar/enrichment-runner", () => ({
  runEnrichment: hoisted.enrich,
}));

const EVENT_DATE = "2026-08-27";

const COMPOSED = {
  symbol: "CRWX",
  title: "CRWX Earnings Recap",
  markdown: "# recap",
  aiMarkdown: "# recap",
  html: "<p>recap</p>",
  promptHash: "abc",
};

interface StreamEvent {
  progress?: { phase: string; message: string; attempt?: number; maxAttempts?: number };
  complete?: boolean;
  data?: Record<string, unknown>;
  error?: string;
  heartbeat?: boolean;
}

function seedEvent(): number {
  const row = hoisted.db
    .prepare(
      `INSERT INTO calendar_events (
         source, event_type, event_date, event_time, release_time, title,
         symbol, source_key, week_of
       ) VALUES ('finnhub','earnings',?, 'AMC', '17:00', 'CRWX earnings',
                 'CRWX', ?, ?)
       RETURNING id`,
    )
    .get(EVENT_DATE, `finnhub:CRWX:${EVENT_DATE}`, EVENT_DATE) as { id: number };
  return row.id;
}

function postReq(body: unknown, signal?: AbortSignal): Request {
  return new Request("http://test/api/earnings/recap-modal", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  });
}

/** Read the SSE body to the end; `onEvent` sees each event as it arrives. */
async function readEvents(
  res: Response,
  onEvent?: (e: StreamEvent) => void,
): Promise<{ events: StreamEvent[]; done: boolean }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  let buffer = "";
  let done = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      const event = JSON.parse(payload) as StreamEvent;
      events.push(event);
      onEvent?.(event);
    }
  }
  return { events, done };
}

function emailRowCount(): number {
  return (
    hoisted.db.prepare(`SELECT COUNT(*) AS n FROM earnings_emails`).get() as { n: number }
  ).n;
}

async function post(body: unknown, signal?: AbortSignal): Promise<Response> {
  const mod = await import("@/app/api/earnings/recap-modal/route");
  return mod.POST(postReq(body, signal));
}

beforeEach(() => {
  hoisted.db = new Database(":memory:");
  hoisted.db.pragma("foreign_keys = ON");
  runMigrations(hoisted.db);
  hoisted.compose.mockReset();
  hoisted.enrich.mockReset();
  hoisted.enrich.mockResolvedValue([{ actual: "EPS 1.42", reaction: null }]);
});

describe("POST /api/earnings/recap-modal — SSE generate flow", () => {
  it("streams named phases, then a terminal complete carrying the JSON payload", async () => {
    const eventId = seedEvent();
    hoisted.compose.mockResolvedValue(COMPOSED);

    const res = await post({ eventId });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const { events, done } = await readEvents(res);
    const phases = events.filter((e) => e.progress).map((e) => e.progress!.phase);
    expect(phases).toEqual(["enriching", "generating"]);
    for (const e of events.filter((x) => x.progress)) {
      expect(e.progress!.message.length).toBeGreaterThan(0);
    }

    const last = events[events.length - 1];
    expect(last.complete).toBe(true);
    expect(last.data).toEqual({
      success: true,
      html: "<p>recap</p>",
      title: "CRWX Earnings Recap",
      eventDate: EVENT_DATE,
      symbol: "CRWX",
      phase: "recap",
      markdown: "# recap",
      enriched: { actual: "EPS 1.42", reaction: null },
    });
    expect(events.some((e) => e.error)).toBe(false);
    expect(done).toBe(true);
    expect(hoisted.compose).toHaveBeenCalledTimes(1);
  });

  it("hands the composer an AbortSignal so the AI request can be cancelled", async () => {
    const eventId = seedEvent();
    hoisted.compose.mockResolvedValue(COMPOSED);
    await readEvents(await post({ eventId }));
    const opts = hoisted.compose.mock.calls[0][3] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.signal!.aborted).toBe(false);
  });

  it("retries once after a failed first attempt and says so in a phase event", async () => {
    const eventId = seedEvent();
    hoisted.compose
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(COMPOSED);

    const { events } = await readEvents(await post({ eventId }));
    const retries = events.filter((e) => e.progress?.phase === "retrying");
    expect(retries).toHaveLength(1);
    expect(retries[0].progress!.message).toMatch(/retrying \(attempt 2 of 2\)/);
    expect(retries[0].progress).toMatchObject({ attempt: 2, maxAttempts: 2 });
    expect(events[events.length - 1].complete).toBe(true);
    expect(hoisted.compose).toHaveBeenCalledTimes(2);
  });

  it("stops at 2 total attempts with a plain-language error and stores nothing", async () => {
    const eventId = seedEvent();
    hoisted.compose.mockRejectedValue(
      new Error('400 {"type":"error","error":{"type":"x","message":"req_abc123 raw vendor prose"}}'),
    );

    const { events, done } = await readEvents(await post({ eventId }));
    expect(hoisted.compose).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.complete)).toBe(false);
    const last = events[events.length - 1];
    expect(typeof last.error).toBe("string");
    // Plain language: no vendor envelope, no request id.
    expect(last.error).not.toMatch(/req_abc123|\{|raw vendor prose/);
    expect(done).toBe(true);
    expect(emailRowCount()).toBe(0);
  });

  it("does not retry a domain refusal — not-reported-yet is a complete, not an error", async () => {
    const eventId = seedEvent();
    const { EarningsEmailError } = await import("@/lib/digest/send-earnings-email");
    hoisted.compose.mockRejectedValue(new EarningsEmailError("no actual yet", 409));

    const { events } = await readEvents(await post({ eventId }));
    expect(hoisted.compose).toHaveBeenCalledTimes(1);
    const last = events[events.length - 1];
    expect(last.complete).toBe(true);
    expect(last.data).toMatchObject({ success: false, notReady: true });
    expect(events.some((e) => e.progress?.phase === "retrying")).toBe(false);
  });

  it("an abort mid-generation ends the run: no complete, no retry, nothing stored", async () => {
    const eventId = seedEvent();
    const ac = new AbortController();
    let rejectCompose: (err: Error) => void = () => {};
    hoisted.compose.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCompose = reject;
        }),
    );

    const res = await post({ eventId }, ac.signal);
    const { events } = await readEvents(res, (e) => {
      if (e.progress?.phase === "generating") {
        ac.abort();
        // The in-flight AI call dies with the abort — which must NOT be
        // mistaken for a retryable failure.
        rejectCompose(new Error("Request was aborted."));
      }
    });

    expect(hoisted.compose).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.complete)).toBe(false);
    expect(events.some((e) => e.progress?.phase === "retrying")).toBe(false);
    expect(emailRowCount()).toBe(0);
  });

  it("an AI call that dies with the SDK's abort error is a cancel: no retry, no error event", async () => {
    const eventId = seedEvent();
    const ac = new AbortController();
    // What the composer does once it honours the signal: reject when aborted.
    hoisted.compose.mockImplementation(
      (_db: unknown, _id: number, _phase: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const err = new Error("Request was aborted.");
            err.name = "APIUserAbortError";
            reject(err);
          });
        }),
    );

    const res = await post({ eventId }, ac.signal);
    const { events } = await readEvents(res, (e) => {
      if (e.progress?.phase === "generating") ac.abort();
    });

    expect(hoisted.compose).toHaveBeenCalledTimes(1);
    expect((hoisted.compose.mock.calls[0][3] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(events.some((e) => e.complete || e.error)).toBe(false);
    expect(events.some((e) => e.progress?.phase === "retrying")).toBe(false);
    expect(emailRowCount()).toBe(0);
  });

  it("an abort before the AI step never starts it", async () => {
    const eventId = seedEvent();
    const ac = new AbortController();
    hoisted.enrich.mockImplementation(async () => {
      ac.abort();
      return [{ actual: "EPS 1.42", reaction: null }];
    });

    const { events } = await readEvents(await post({ eventId }, ac.signal));
    expect(hoisted.compose).not.toHaveBeenCalled();
    expect(events.some((e) => e.complete)).toBe(false);
  });

  it("keeps plain JSON for a malformed body (no stream to read)", async () => {
    const res = await post({ eventId: "nope" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
  });
});
