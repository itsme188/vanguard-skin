/**
 * The Hub's ONE live controller (slice F task 9 — M-F3, M-F6, M-F12, M-F13),
 * plus the two Codex-round-1 additions: the cadence rule that keeps a fresh
 * parse HOT until its read is under way (#9b), and the block that surfaces a
 * live print whose event is not in the rendered week (#14 / F-S10).
 *
 * There is NO mounted integration test here and none is possible: React Testing
 * Library and jsdom are not dependencies of this repo and none may be added. So
 * the wiring is proven four ways —
 *   (1) pure exported helpers (`statusIntervalMs`, `orphanPrints`,
 *       `hasLiveCountdown`) tested as functions, which is where every decision
 *       that matters actually lives;
 *   (2) the four polling streams driven through `buildHubStreams` with an
 *       injected fetch (fix round 2, review I4) — they are plain data over a
 *       `fetchImpl`, so the URL, the METHOD per trigger and what a failure does
 *       are all assertable with no DOM;
 *   (3) `react-dom/server` `renderToStaticMarkup` for the one presentational
 *       piece that takes its rows as a prop (`LivePrintsOutsideWeek`);
 *   (4) `readFileSync` source pins for the effects that have no render surface
 *       and no seam at all.
 * Every identifier below is synthetic (R-F8).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LivePrintsOutsideWeek,
  buildHubStreams,
  hasLiveCountdown,
  orphanPrints,
  statusIntervalMs,
  type HubStreamArgs,
} from "@/app/dashboard/today/EarningsHubLive";
import type { FetchImpl, StreamSpec } from "@/app/dashboard/today/hub-live/poll-controller";
import type {
  CockpitPayloadWire,
  CockpitRowWire,
  PrepareStepWire,
  PrintStatusEntry,
} from "@/app/dashboard/today/hub-live/types";

const entry = (o: Partial<PrintStatusEntry> = {}): PrintStatusEntry => ({
  printId: 1,
  eventId: 10,
  symbol: "XMPL1",
  state: "scheduled",
  sources: {},
  coverage: [],
  lines: [],
  ...o,
});

describe("statusIntervalMs — polling follows the print state (spec §4.6)", () => {
  it("is cool with nothing live and nothing pending", () => {
    expect(statusIntervalMs([])).toBe(30_000);
    expect(statusIntervalMs([entry(), entry({ printId: 2, state: "expired" })])).toBe(30_000);
  });

  it("stays HOT on a fresh parse until a read exists or an attempt has failed (Codex 9b)", () => {
    // Slice D arms the first-pass read five seconds AFTER the parse lands.
    // Cooling to 30s the instant the state flips would hide that read for up
    // to half a minute at the busiest moment of the desk's day.
    expect(statusIntervalMs([entry({ state: "parsed" })])).toBe(2_000);
    expect(statusIntervalMs([entry({ state: "parsed", read: { id: 1 } as never })])).toBe(30_000);
    expect(statusIntervalMs([entry({ state: "parsed", lastAttempt: { id: 2 } as never })])).toBe(
      30_000,
    );
  });

  it("is hot while any print is window_open or acquired", () => {
    expect(statusIntervalMs([entry({ state: "window_open" })])).toBe(2_000);
    expect(
      statusIntervalMs([entry({ state: "expired" }), entry({ printId: 2, state: "acquired" })]),
    ).toBe(2_000);
  });

  it("is hot while a go request is queued or claimed, even on a scheduled print", () => {
    expect(
      statusIntervalMs([
        entry({ goRequest: { id: 1, status: "queued", attempts: 0, requestedAt: "t", result: null } }),
      ]),
    ).toBe(2_000);
    expect(
      statusIntervalMs([
        entry({
          goRequest: { id: 1, status: "claimed", attempts: 1, requestedAt: "t", result: null },
        }),
      ]),
    ).toBe(2_000);
    expect(
      statusIntervalMs([
        entry({
          state: "expired",
          goRequest: { id: 1, status: "done", attempts: 1, requestedAt: "t", result: [] },
        }),
      ]),
    ).toBe(30_000);
  });

  it("is hot while a first-pass read is generating", () => {
    expect(
      statusIntervalMs([
        entry({
          state: "parsed",
          activeRead: { id: 1, status: "generating", nonce: 0, attempts: 1, claimed_at: "t" },
        }),
      ]),
    ).toBe(2_000);
  });
});

/**
 * Review I1. The gate used to be `cockpit.nextRelease != null`, which the
 * cockpit query computes from TODAY's rows only — while M-F5 widened the
 * payload and the chips render a countdown for the whole WEEK. The tick is now
 * gated on the rows actually rendered.
 */
describe("hasLiveCountdown — the clock runs for what is on screen (review I1)", () => {
  const row = (
    state: "upcoming" | "released" | "unknown",
    releaseInstant: string | null,
  ): CockpitRowWire =>
    ({ stages: { released: { state, releaseInstant } } }) as unknown as CockpitRowWire;

  it("does not tick with no rows and no prints", () => {
    expect(hasLiveCountdown(undefined, 0)).toBe(false);
    expect(hasLiveCountdown({}, 0)).toBe(false);
  });

  it("KEEPS TICKING for a week-ahead row on a day with nothing reporting", () => {
    // The bug this closes: a Monday whose only upcoming releases are Wednesday
    // rows. `nextRelease` is null there, so the old gate never started the tick
    // and every Wednesday countdown froze at its mount value all session.
    expect(hasLiveCountdown({ 42: row("upcoming", "2026-09-09T20:05:00.000Z") }, 0)).toBe(true);
  });

  it("stops once every rendered release has happened", () => {
    expect(
      hasLiveCountdown({ 42: row("released", "2026-09-07T20:05:00.000Z"), 43: row("unknown", null) }, 0),
    ).toBe(false);
  });

  it("does not tick for an upcoming row whose release instant is unknown", () => {
    // Nothing to count down to — the chip renders no countdown for it either.
    expect(hasLiveCountdown({ 42: row("upcoming", null) }, 0)).toBe(false);
  });

  it("ticks whenever a live print exists, because the window text reads the same clock", () => {
    // LivePrintSlot's headline decides "window opens 16:05" vs "window open
    // until 16:35" off nowMs. A frozen clock there can contradict the state
    // chip printed beside it in the same sentence.
    expect(hasLiveCountdown({}, 1)).toBe(true);
  });
});

describe("orphanPrints (Codex 14 / F-S10)", () => {
  it("keeps only the prints whose event is not in the rendered week, oldest print first", () => {
    const byEvent = {
      10: entry({ printId: 1, eventId: 10 }),
      99: entry({ printId: 7, eventId: 99, symbol: "XMPL2" }),
    };
    expect(orphanPrints(byEvent, [10]).map((p) => p.printId)).toEqual([7]);
    expect(orphanPrints(byEvent, [10, 99])).toEqual([]);
  });

  it("skips an entry with no eventId rather than guessing where it belongs", () => {
    expect(orphanPrints({ 0: entry({ printId: 3, eventId: undefined }) }, [10])).toEqual([]);
  });
});

/**
 * Review I4 — the four streams, driven for real.
 *
 * They were proven only by source regexes, which cannot tell an inverted
 * POST/GET ternary from a correct one. `buildHubStreams` takes its fetch from
 * the controller, so a fake one is all a behavioural test needs.
 */
describe("buildHubStreams — the four polls, driven with a fake fetch (review I4)", () => {
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }

  const jsonRes = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

  function harness(
    responder: (url: string) => Response,
    overrides: Partial<HubStreamArgs> = {},
  ) {
    const calls: Call[] = [];
    const seen = {
      status: [] as PrintStatusEntry[][],
      statusErrors: [] as string[],
      cockpit: [] as CockpitPayloadWire[],
      prepare: [] as Array<Record<number, PrepareStepWire[]>>,
    };
    const args: HubStreamArgs = {
      weekOf: "2026-09-07",
      eventIds: [10, 11],
      hasInitialCockpit: false,
      printsRef: { current: [] },
      onStatus: (rows) => seen.status.push(rows),
      onStatusError: (m) => seen.statusErrors.push(m),
      onCockpit: (p) => seen.cockpit.push(p),
      onPrepare: (p) => seen.prepare.push(p),
      ...overrides,
    };
    const fetchImpl: FetchImpl = async (input, init) => {
      calls.push({ url: String(input), init });
      return responder(String(input));
    };
    const byName = new Map<string, StreamSpec<unknown>>(
      buildHubStreams(args).map((s) => [s.name, s]),
    );
    const signal = new AbortController().signal;
    return { calls, seen, byName, fetchImpl, signal, args };
  }

  const okStatus = () => jsonRes({ success: true, data: { prints: [entry()] } });

  it("names all four streams", () => {
    const { byName } = harness(okStatus);
    expect([...byName.keys()].sort()).toEqual(["cockpit", "ensure", "prepare", "status"]);
  });

  it("status GETs its route and hands the rows straight back", async () => {
    const h = harness(okStatus);
    const rows = await h.byName.get("status")!.run(h.signal, h.fetchImpl, "timer");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("/api/print-watch/status");
    expect(h.calls[0].init?.method).toBeUndefined();
    h.byName.get("status")!.onResult(rows);
    expect(h.seen.status[0]?.[0]?.symbol).toBe("XMPL1");
  });

  it("status throws the SERVER's error string, and that is what the banner shows", async () => {
    const h = harness(() => jsonRes({ success: false, error: "watcher lease lost" }, 500));
    const stream = h.byName.get("status")!;
    await expect(stream.run(h.signal, h.fetchImpl, "timer")).rejects.toThrow("watcher lease lost");
    stream.onError!(new Error("watcher lease lost"));
    expect(h.seen.statusErrors).toEqual(["watcher lease lost"]);
  });

  it("status re-reads its cadence from the ref, so a print going hot needs no restart", () => {
    const printsRef = { current: [] as PrintStatusEntry[] };
    const { byName } = harness(okStatus, { printsRef });
    expect(byName.get("status")!.intervalMs()).toBe(30_000);
    printsRef.current = [entry({ state: "window_open" })];
    expect(byName.get("status")!.intervalMs()).toBe(2_000);
  });

  it("ensure POSTs, and a failure is a console warning — never a user-facing error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness(() => jsonRes({ success: false, error: "no lease" }, 503));
      const stream = h.byName.get("ensure")!;
      // No onError at all: /ensure only arms the watcher loops, so a failure
      // must never reach the status banner.
      expect(stream.onError).toBeUndefined();
      await expect(stream.run(h.signal, h.fetchImpl, "timer")).resolves.toBeNull();
      expect(h.calls[0].url).toBe("/api/print-watch/ensure");
      expect(h.calls[0].init?.method).toBe("POST");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("no lease");
    } finally {
      warn.mockRestore();
    }
  });

  it("ensure stays quiet when it succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = harness(() => jsonRes({ success: true }));
      await h.byName.get("ensure")!.run(h.signal, h.fetchImpl, "timer");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  const cockpitPayload: CockpitPayloadWire = {
    generatedAt: "2026-09-07T13:00:00.000Z",
    nextRelease: null,
    lanes: { bmo: [], amc: [], unknown: [] },
    carryover: [],
    skippedRows: 0,
    rowsByEvent: {},
  };

  it("cockpit issues NO request on start when the server handed a payload down (Codex 7 / F-S2)", async () => {
    const h = harness(() => jsonRes({ success: true, data: cockpitPayload }), {
      hasInitialCockpit: true,
    });
    await expect(h.byName.get("cockpit")!.run(h.signal, h.fetchImpl, "start")).resolves.toBeNull();
    expect(h.calls).toHaveLength(0);
  });

  it("cockpit DOES read on start when the server handed nothing down", async () => {
    const h = harness(() => jsonRes({ success: true, data: cockpitPayload }));
    await h.byName.get("cockpit")!.run(h.signal, h.fetchImpl, "start");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].init?.method).toBeUndefined();
  });

  it("POSTs the cockpit ONLY on the timer tick — POST is the intel refresh, which writes", async () => {
    const h = harness(() => jsonRes({ success: true, data: cockpitPayload }), {
      hasInitialCockpit: true,
    });
    const stream = h.byName.get("cockpit")!;
    await stream.run(h.signal, h.fetchImpl, "timer");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("/api/earnings/cockpit?weekOf=2026-09-07");
    expect(h.calls[0].init?.method).toBe("POST");
  });

  it("GETs the cockpit on a mutation refresh and on a tab coming back", async () => {
    const h = harness(() => jsonRes({ success: true, data: cockpitPayload }), {
      hasInitialCockpit: true,
    });
    const stream = h.byName.get("cockpit")!;
    await stream.run(h.signal, h.fetchImpl, "refresh");
    await stream.run(h.signal, h.fetchImpl, "resume");
    expect(h.calls.map((c) => c.init?.method)).toEqual([undefined, undefined]);
    expect(new Set(h.calls.map((c) => c.url))).toEqual(
      new Set(["/api/earnings/cockpit?weekOf=2026-09-07"]),
    );
  });

  it("cockpit keeps the last good payload rather than blanking a rendered chip strip", async () => {
    const h = harness(() => jsonRes({ success: false }, 500), { hasInitialCockpit: true });
    const stream = h.byName.get("cockpit")!;
    await expect(stream.run(h.signal, h.fetchImpl, "timer")).rejects.toThrow();
    stream.onError!(new Error("cockpit refresh failed"));
    expect(h.seen.cockpit).toEqual([]);
  });

  it("prepare reads the WORKSHEET route for the week's events (M-F15)", async () => {
    const h = harness(() => jsonRes({ success: true, data: { prepare: { 10: [] } } }));
    const stream = h.byName.get("prepare")!;
    const out = await stream.run(h.signal, h.fetchImpl, "timer");
    expect(h.calls[0].url).toBe("/api/earnings/worksheet?eventIds=10,11");
    expect(h.calls[0].init?.method).toBeUndefined();
    stream.onResult(out);
    expect(h.seen.prepare).toEqual([{ 10: [] }]);
  });

  it("prepare makes no request at all for an empty week", async () => {
    const h = harness(okStatus, { eventIds: [] });
    await expect(h.byName.get("prepare")!.run(h.signal, h.fetchImpl, "timer")).resolves.toEqual({});
    expect(h.calls).toHaveLength(0);
  });

  it("runs the two slow streams on a flat minute and never faster", () => {
    const { byName } = harness(okStatus);
    expect(byName.get("cockpit")!.intervalMs()).toBe(60_000);
    expect(byName.get("prepare")!.intervalMs()).toBe(60_000);
    expect(byName.get("ensure")!.intervalMs()).toBe(60_000);
  });
});

describe("LivePrintsOutsideWeek render", () => {
  it("renders nothing when every live print is in the week", () => {
    expect(renderToStaticMarkup(createElement(LivePrintsOutsideWeek, { prints: [] }))).toBe("");
  });

  it("names the orphan's symbol and state under its own header", () => {
    const html = renderToStaticMarkup(
      createElement(LivePrintsOutsideWeek, {
        prints: [entry({ printId: 7, eventId: 99, symbol: "XMPL2", state: "window_open" })],
      }),
    );
    expect(html).toContain("Live prints outside this week");
    expect(html).toContain("XMPL2");
    expect(html).toContain("window open");
  });
});

describe("EarningsHubLive source", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubLive.tsx", "utf8");

  it("owns EVERY poll the deleted components owned: status, ensure, cockpit, prepare", () => {
    expect(src).toMatch(/\/api\/print-watch\/status/);
    expect(src).toMatch(/\/api\/print-watch\/ensure/);
    expect(src).toMatch(/\/api\/earnings\/cockpit\?weekOf=/);
    expect(src).toMatch(/\/api\/earnings\/worksheet\?eventIds=/);
  });

  it("pauses on a hidden tab and resumes on visible", () => {
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/document\.visibilityState === "hidden"/);
    expect(src).toMatch(/\.pause\(\)/);
    expect(src).toMatch(/\.resume\(\)/);
  });

  it("clears the not-updating banner when the polls stop (review M3)", () => {
    // Nothing is polling on a hidden tab or after the controller is torn down,
    // so a surviving banner outlives the condition it describes.
    const pause = src.indexOf("controller.pause()");
    const cleared = src.indexOf("setStatusError(null)", pause);
    expect(pause).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(pause);
    // …and again in the effect teardown.
    expect(src.match(/setStatusError\(null\)/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the mutation re-fetch the cockpit had (the earnings-data-changed event)", () => {
    expect(src).toMatch(/earnings-data-changed/);
  });

  it("onChanged AWAITS both refreshes, in parallel (R-F24)", () => {
    // Children drop their busy state in the `finally` after `await onChanged()`.
    // Resolving when the requests were merely ISSUED re-arms an accept button
    // while the row still shows the pre-mutation sheet. Parallel, not serial:
    // two independent requests, and the desk waits on the slower one.
    expect(src).toMatch(
      /await Promise\.all\(\[controller\.refresh\("status"\), controller\.refresh\("cockpit"\)\]\)/,
    );
  });

  it("uses the shared controller rather than its own timers", () => {
    expect(src).toMatch(/createPollController/);
    expect(src).not.toMatch(/setInterval\(/);
  });

  it("gates the 1 s tick on the rendered rows, not on today-only nextRelease (review I1)", () => {
    // `nextRelease` is a TODAY-only field; the chips count down the whole week.
    expect(src).toMatch(/hasUpcoming\s*=\s*useMemo\([\s\S]{0,120}?hasLiveCountdown\(/);
    expect(src).toMatch(/hasLiveCountdown\(cockpit\?\.rowsByEvent,\s*prints\.length\)/);
    expect(src).not.toMatch(/hasUpcoming\s*=\s*cockpit/);
  });

  it("does not start the controller in a tab that mounts hidden (Codex 9a)", () => {
    // Whitespace-tolerant (review M2): a Prettier reflow must not fail a green
    // test with no behaviour change.
    expect(src).toMatch(/document\.visibilityState !== "hidden"\)\s*\{?\s*controller\.start\(\)/);
  });

  it("takes the freshest cockpit payload the server hands down, without clobbering a newer one (review I3)", () => {
    // Five mutation paths only call router.refresh(); useState's initial value
    // is read once, so the fresh RSC payload was silently dropped.
    expect(src).toMatch(/setCockpit\(\(current\)\s*=>/);
    expect(src).toMatch(/current\.generatedAt > initialCockpit\.generatedAt/);
    expect(src).toMatch(/\}, \[initialCockpit\]\);/);
  });

  it("captures the previous print snapshot BEFORE overwriting the ref (Codex 8 / F-S1)", () => {
    expect(src).toMatch(/const prevSnap = snapRef\.current\[id\] \?\? null;/);
    const capture = src.indexOf("const prevSnap = snapRef.current[id]");
    const write = src.indexOf("snapRef.current[id] = snap");
    expect(capture).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(write);
    expect(src).toMatch(/nextOpenState\(/);
    expect(src).toMatch(/prevPrintId: prevSnap\?\.printId \?\? null/);
  });

  it("keeps ONE expansion decision for both responsive twins (review I2)", () => {
    // EarningsHub renders a desktop row and a mobile card for every event and
    // hides one with CSS. Per-slot open state diverged the moment the desk
    // toggled one, and app/globals.css swaps which twin is visible on the chat
    // rail attribute with no remount (M-F14's band).
    expect(src).toMatch(/openByEvent: Record<number, boolean>/);
    expect(src).toMatch(/toggleRow: \(eventId: number, printId: number \| null\) => void/);
    expect(src).toMatch(/live\.openByEvent\[eventId\] \?\? false/);
    // The reducer runs once, in the provider — not once per twin.
    expect(src.match(/deriveExpansion\(/g)).toHaveLength(1);
  });

  it("renders the expansion body only in the twin the desk can actually see (review I2)", () => {
    // Same structural check EarningsRowChips has used since the 4th recurrence:
    // offsetParent is null under any display:none ancestor. Without it,
    // IrPageField's mount effect fires GET /api/print-watch/sources twice.
    expect(src).toMatch(/offsetParent !== null/);
    expect(src).toMatch(/attributeFilter: \["data-chat-rail"\]/);
    expect(src.match(/open && isVisibleTwin/g)).toHaveLength(2);
  });

  it("prints the state and the window ONCE, and never off the wall clock (reviews M1, M4)", () => {
    // Expanded, LivePrintRow prints its own state chip and window line directly
    // under this headline. Saying it twice is noise — and before the clock fix
    // the two copies could disagree, because they read different clocks.
    expect(src).toMatch(/open\s*\?\s*"live print"/);
    // Every window string in this file reads the provider's shared nowMs. A
    // `Date.now()` in render is impure and re-introduces exactly that
    // disagreement.
    expect(src).not.toMatch(/windowText\([^)]*Date\.now\(\)/);
    expect(src).toMatch(/<LivePrintsOutsideWeek[^>]*nowMs=\{nowMs\}/);
  });

  it("surfaces a failed status poll ONCE, not once per row", () => {
    // One request feeds every row, so a per-slot error line would print the
    // same sentence N times for a single failure.
    expect(src.match(/\{statusError && \(/g)).toHaveLength(1);
    expect(src).not.toMatch(/live\?\.statusError/);
  });

  it("wraps every localStorage access, and spells the toggle out as words", () => {
    // readManual / writeManual own the try/catch (hub-live/expansion.ts); this
    // file must never touch the accessor itself.
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/"collapse" : "expand"/);
    expect(src).not.toMatch(/▾|▸|▼|►/);
  });

  it("never defines a component inside another component's body (remount trap)", () => {
    const inner = src.split("export default function EarningsHubLive")[1] ?? "";
    expect(inner).not.toMatch(/\n\s+function [A-Z]/);
    // The arrow form is the commoner way to fall into it (review M7).
    expect(inner).not.toMatch(/\n\s+const [A-Z]\w*\s*=\s*(?:\(|function)/);
  });
});

describe("EarningsHub wiring", () => {
  const src = readFileSync("app/dashboard/today/EarningsHub.tsx", "utf8");

  it("computes the initial cockpit payload server-side for the Hub's week", () => {
    expect(src).toMatch(/buildCockpitPayload\(db, new Date\(\), \{ weekOf \}\)/);
    expect(src).toMatch(/decorateCockpitIntel\(db, /);
  });

  it("wraps the rows in the client provider and drops one slot per row on BOTH layouts", () => {
    expect(src).toMatch(/<EarningsHubLive/);
    expect(src.match(/<LivePrintSlot\b/g)).toHaveLength(2); // desktop + mobile
  });

  it("hands each slot the symbol, so the armed-with-no-print path can key IrPageField", () => {
    // The plan's literal pin was `symbol={e.symbol}`; CalendarEvent.symbol is
    // `string | null` (lib/types.ts), so the shipped call coalesces. The pin
    // stops before the brace: what it has to prove is that the SYMBOL reaches
    // the slot, not how a null one is spelled.
    expect(src.match(/<LivePrintSlot eventId=\{e\.id\} symbol=\{e\.symbol/g)).toHaveLength(2);
  });

  it("keeps the expansion inside the two responsive containers so globals.css still switches it", () => {
    // .earnings-hub-desktop / .earnings-hub-mobile are the md: + rail switch
    // (app/globals.css). A slot outside them would render twice at 1280.
    const desktop = src.slice(src.indexOf("earnings-hub-desktop"), src.indexOf("earnings-hub-mobile"));
    expect(desktop).toMatch(/<LivePrintSlot/);
  });

  it("adds no grid span — the row containers are blocks, the grid is per row", () => {
    expect(src).not.toMatch(/col-span-full/);
  });

  it("still exports force-dynamic behaviour through the page, and keeps its db reads", () => {
    expect(src).toMatch(/from "@\/lib\/db"/);
  });
});

describe("EarningsRowChips reads the live cockpit row from context", () => {
  const src = readFileSync("app/dashboard/today/EarningsRowChips.tsx", "utf8");

  it("takes the row from useHubLive() instead of a prop the server row must thread", () => {
    expect(src).toMatch(/useHubLive\(\)/);
    expect(src).toMatch(/cockpitByEvent\[eventId\]/);
    expect(src).not.toMatch(/cockpitRow\?: CockpitRowWire/);
  });

  it("degrades to its server props outside the provider", () => {
    // useHubLive() returns null there, so the strip is simply absent — the
    // arm / skip / generate controls below it are untouched.
    expect(src).toMatch(/live\?\.cockpitByEvent\[eventId\] \?\? null/);
  });

  it("keeps the cockpit chip lane inside its grid cell instead of spilling over Δ and Bogeys", () => {
    // Sandbox E2E 2026-09-04: the lane was `flex flex-col items-end gap-0.5
    // shrink-0`, which sizes to max-content (~267px) inside a 160px Email
    // column. A `justify-end` flex line lays an oversized item out from the
    // RIGHT edge leftwards, so the chips painted across the Δ and Bogeys
    // columns — 4 of the 5 rows carrying a Δ, at 1440 AND at 1920. Same class
    // of defect as the 2026-07-27 "+ BOG silently skipped the recap" bug the
    // root's own comment records, and the same fix: let it shrink so its
    // flex-wrap engages.
    const lane = src.slice(src.indexOf("{cockpitRow && ("));
    const laneOpen = lane.slice(lane.indexOf("<span className=\"flex flex-col"), lane.indexOf("<StageChipStrip"));
    expect(laneOpen).not.toMatch(/shrink-0/);
    expect(laneOpen).toMatch(/min-w-0/);
    // The row holding the chips + countdown must wrap too — a non-wrapping
    // inline-flex there just moves the overflow one level down.
    expect(laneOpen).toMatch(/flex-wrap/);
    // The two groups BELOW the lane keep their shrink-0: wrapping is meant to
    // happen between groups, never mid-group.
    expect(src).toMatch(/inline-flex items-center gap-1\.5 shrink-0/);
  });
});
