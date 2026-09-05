/**
 * The Hub's ONE live controller (slice F task 9 — M-F3, M-F6, M-F12, M-F13),
 * plus the two Codex-round-1 additions: the cadence rule that keeps a fresh
 * parse HOT until its read is under way (#9b), and the block that surfaces a
 * live print whose event is not in the rendered week (#14 / F-S10).
 *
 * There is NO mounted integration test here and none is possible: React Testing
 * Library and jsdom are not dependencies of this repo and none may be added. So
 * the wiring is proven three ways —
 *   (1) pure exported helpers (`statusIntervalMs`, `orphanPrints`) tested as
 *       functions, which is where every decision that matters actually lives;
 *   (2) `react-dom/server` `renderToStaticMarkup` for the one presentational
 *       piece that takes its rows as a prop (`LivePrintsOutsideWeek`);
 *   (3) `readFileSync` source pins for the effects and the stream wiring, which
 *       have no render surface at all.
 * Every identifier below is synthetic (R-F8).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LivePrintsOutsideWeek,
  orphanPrints,
  statusIntervalMs,
} from "@/app/dashboard/today/EarningsHubLive";
import type { PrintStatusEntry } from "@/app/dashboard/today/hub-live/types";

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

  it("keeps the mutation re-fetch the cockpit had (the earnings-data-changed event)", () => {
    expect(src).toMatch(/earnings-data-changed/);
  });

  it("uses the shared controller rather than its own timers", () => {
    expect(src).toMatch(/createPollController/);
    expect(src).not.toMatch(/setInterval\(/);
  });

  it("issues NO cockpit request on start when the server handed a payload down (Codex 7 / F-S2)", () => {
    expect(src).toMatch(/trigger === "start" && initialCockpit/);
    expect(src).toMatch(/return null;/);
    expect(src).not.toMatch(/firstCockpitRun/);
  });

  it("POSTs the cockpit only on the timer tick, and GETs on refresh and resume", () => {
    expect(src).toMatch(/trigger === "timer"\s*\?\s*\{ signal, method: "POST"/);
  });

  it("does not start the controller in a tab that mounts hidden (Codex 9a)", () => {
    expect(src).toMatch(/document\.visibilityState !== "hidden"\) controller\.start\(\)/);
  });

  it("captures the previous print id BEFORE overwriting the ref (Codex 8 / F-S1)", () => {
    expect(src).toMatch(/const prevPrintId = prevRef\.current\?\.printId \?\? null;/);
    const capture = src.indexOf("const prevPrintId");
    const write = src.indexOf("prevRef.current = next");
    expect(capture).toBeLessThan(write);
    expect(src).toMatch(/nextOpenState\(/);
  });

  it("renders the outside-the-week block as a top-level sibling of the children", () => {
    expect(src).toMatch(/\{children\}\s*<LivePrintsOutsideWeek/);
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
});
