"use client";

/**
 * The Hub's ONE live controller (spec §4.6). Everything the Earnings Cockpit
 * and the Live Print Watch panel used to poll separately is polled here once:
 * print-watch status (hot 2 s / cool 30 s), the 60-second `/ensure` that keeps
 * the watcher lease alive, the cockpit intel refresh for the whole rendered
 * week, and the worksheet prepare rows.
 *
 * SHAPE (M-F12): this is a client PROVIDER wrapped around SERVER children.
 * `EarningsHub` stays a server component — it keeps its nine `db` reads and its
 * `EarningsDateChip` / `BogeysEditButton` / `EarningsDeleteButton` /
 * `RecapFigureButton` subtree — and renders its day blocks INSIDE this
 * provider, dropping a `<LivePrintSlot>` client leaf immediately after each
 * server row. A client leaf rendered inside a client provider's server children
 * DOES receive that provider's context (the provider is above it in the client
 * tree at hydration), so one controller feeds every row with no prop drilling
 * and no second poll.
 *
 * CLIENT BOUNDARY (M-F18): every module reached from here is browser-safe. The
 * cockpit payload's wire shapes are re-declared in `./hub-live/types` rather
 * than imported from `@/lib/queries/earnings-cockpit`, which is a server
 * module; `buildCockpitPayload` and `decorateCockpitIntel` are called ONLY in
 * `EarningsHub.tsx`, which is a server component. A value import across that
 * line does not fail a test — it fails `next build` outright.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import apiFetch from "@/lib/http/apiFetch";
import LivePrintRow from "./LivePrintRow";
import IrPageField from "./live-print/IrPageField";
import PrepareStatus from "./live-print/PrepareStatus";
import {
  deriveExpansion,
  nextOpenState,
  readManual,
  snapshotOf,
  writeManual,
  type ExpansionSnapshot,
  type ManualToggle,
} from "./hub-live/expansion";
import { createPollController, type PollController } from "./hub-live/poll-controller";
import { COOL_POLL_MS, ENSURE_INTERVAL_MS, HOT_POLL_MS, printStateLabel, windowText } from "./live-print/helpers";
import type {
  CockpitPayloadWire,
  CockpitRowWire,
  PrepareStepWire,
  PrintStatusEntry,
} from "./hub-live/types";

/**
 * The status cadence, as one pure function (Codex round 1 #9b).
 *
 * "Polling follows the print state" is not just the two live states: a go press
 * that is queued or claimed IS an acquisition in progress, and a read that is
 * generating IS the sheet moving. The subtle one is `parsed` — slice D arms the
 * first-pass read five seconds AFTER the parse lands, so going cool the instant
 * the state flips would show a filled sheet with no read for up to half a
 * minute and read as a stall.
 */
export function statusIntervalMs(prints: PrintStatusEntry[]): number {
  const hot = prints.some((p) => {
    // The window is open or the document is in hand: the sheet is moving.
    if (p.state === "window_open" || p.state === "acquired") return true;
    // A go press is queued or claimed: the acquisition is happening now.
    if (p.goRequest?.status === "queued" || p.goRequest?.status === "claimed") return true;
    // A read is generating.
    if (p.activeRead != null) return true;
    // Just parsed, no read yet, nothing has failed: slice D arms the read five
    // seconds from the parse, so one IS coming. Going cool here would show a
    // filled sheet with no read for 30 s and look like a stall. Once a read is
    // done, or an attempt has failed or capped, this goes cool again.
    if (p.state === "parsed" && p.read == null && p.lastAttempt == null) return true;
    return false;
  });
  return hot ? HOT_POLL_MS : COOL_POLL_MS;
}

/**
 * Pure, so the selection is testable without a DOM. A status entry with no
 * `eventId` cannot be placed at all and is left out rather than guessed at.
 */
export function orphanPrints(
  printByEvent: Record<number, PrintStatusEntry>,
  eventIds: number[],
): PrintStatusEntry[] {
  const inWeek = new Set(eventIds);
  return Object.values(printByEvent)
    .filter((p) => p.eventId !== undefined && !inWeek.has(p.eventId))
    .sort((a, b) => a.printId - b.printId);
}

export interface HubLiveValue {
  printByEvent: Record<number, PrintStatusEntry>;
  cockpitByEvent: Record<number, CockpitRowWire>;
  prepareByEvent: Record<number, PrepareStepWire[]>;
  nowMs: number;
  statusError: string | null;
  onChanged: () => Promise<void>;
}

const HubLiveContext = createContext<HubLiveValue | null>(null);

/** `null` outside the provider — every consumer degrades to its server props. */
export function useHubLive(): HubLiveValue | null {
  return useContext(HubLiveContext);
}

/** The fallback when a slot renders outside the provider (tests, and any future
 *  caller): a mutation refresh nobody is listening for is a no-op, not a crash. */
const NO_REFRESH = async () => {};

export default function EarningsHubLive({
  weekOf,
  eventIds,
  initialCockpit,
  children,
}: {
  weekOf: string;
  eventIds: number[];
  initialCockpit: CockpitPayloadWire | null;
  children: ReactNode;
}) {
  const [prints, setPrints] = useState<PrintStatusEntry[]>([]);
  const [cockpit, setCockpit] = useState<CockpitPayloadWire | null>(initialCockpit);
  const [prepare, setPrepare] = useState<Record<number, PrepareStepWire[]>>({});
  const [statusError, setStatusError] = useState<string | null>(null);
  /**
   * 0 means "the client clock has not started yet", and that is deliberate.
   * `initialCockpit` is server-rendered so the stage chips paint with no fetch
   * — which also means this provider RENDERS ON THE SERVER. A countdown is
   * second-granular (`fmtCountdown`: "4m 12s"), so seeding this with
   * `Date.now()` would put the server's clock into the HTML and the browser's
   * into the hydration pass, and every row inside an hour of its release would
   * hydrate with a text mismatch. Consumers therefore render nothing
   * time-derived until this is truthy; the mount effect below fills it in on
   * the very next tick.
   */
  const [nowMs, setNowMs] = useState(0);

  // The scheduler reads live state through a ref, never through its own deps —
  // the useCallback render-loop trap this project has hit before.
  const printsRef = useRef<PrintStatusEntry[]>([]);
  const controllerRef = useRef<PollController | null>(null);
  const idsKey = eventIds.join(",");

  useEffect(() => {
    const controller = createPollController({
      fetchImpl: (input, init) => apiFetch(input, init),
      streams: [
        {
          name: "status",
          intervalMs: () => statusIntervalMs(printsRef.current),
          run: async (signal, fetchImpl) => {
            const res = await fetchImpl("/api/print-watch/status", { signal });
            const data = (await res.json().catch(() => null)) as
              | { success?: boolean; data?: { prints: PrintStatusEntry[] }; error?: string }
              | null;
            if (!res.ok || !data?.success || !data.data) {
              throw new Error(data?.error ?? `Server returned ${res.status}`);
            }
            return data.data.prints;
          },
          onResult: (rows) => {
            printsRef.current = rows as PrintStatusEntry[];
            setPrints(rows as PrintStatusEntry[]);
            setStatusError(null);
          },
          onError: (err) =>
            setStatusError(
              err instanceof Error
                ? err.message
                : "Could not reach the server for print-watch status.",
            ),
        },
        {
          name: "ensure",
          intervalMs: () => ENSURE_INTERVAL_MS,
          run: async (signal, fetchImpl) => {
            const res = await fetchImpl("/api/print-watch/ensure", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
              signal,
            });
            const data = (await res.json().catch(() => null)) as
              | { success?: boolean; error?: string }
              | null;
            // Non-blocking by design — /ensure only arms the watcher loops. But
            // a silently, persistently failing /ensure means the watcher has
            // stopped being kept alive, so it reaches the console.
            if (!res.ok || !data?.success) {
              console.warn(
                `print-watch: /ensure failed (${data?.error ?? `server returned ${res.status}`})`,
              );
            }
            return null;
          },
          onResult: () => undefined,
        },
        {
          name: "cockpit",
          intervalMs: () => 60_000,
          run: async (signal, fetchImpl, trigger) => {
            // A server-rendered payload is the freshest thing there is, so the
            // first run after mount fetches NOTHING. A mutation (`refresh`) or a
            // tab coming back (`resume`) wants a cheap read. Only the 60-second
            // timer POSTs, because POST is the intel REFRESH — it writes, and
            // is TTL-guarded server-side at one refresh per event per 30 min.
            if (trigger === "start" && initialCockpit) return null;
            const url = `/api/earnings/cockpit?weekOf=${encodeURIComponent(weekOf)}`;
            const init: RequestInit =
              trigger === "timer"
                ? { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
                : { signal };
            const res = await fetchImpl(url, init);
            const data = (await res.json().catch(() => null)) as
              | { success?: boolean; data?: CockpitPayloadWire }
              | null;
            if (!res.ok || !data?.success || !data.data) throw new Error("cockpit refresh failed");
            return data.data;
          },
          onResult: (p) => setCockpit(p as CockpitPayloadWire),
          // Keep the last good payload; never blank a rendered chip strip.
          onError: () => undefined,
        },
        {
          name: "prepare",
          intervalMs: () => 60_000,
          run: async (signal, fetchImpl) => {
            if (eventIds.length === 0) return {};
            const res = await fetchImpl(`/api/earnings/worksheet?eventIds=${eventIds.join(",")}`, {
              signal,
            });
            const data = (await res.json().catch(() => null)) as
              | { success?: boolean; data?: { prepare: Record<number, PrepareStepWire[]> } }
              | null;
            if (!res.ok || !data?.success || !data.data) throw new Error("prepare read failed");
            return data.data.prepare;
          },
          onResult: (p) => setPrepare(p as Record<number, PrepareStepWire[]>),
          onError: () => undefined,
        },
      ],
    });
    controllerRef.current = controller;
    // A tab restored in the background must not fire four requests nobody is
    // looking at. Create the controller either way — the visibility handler
    // below is what starts it — but only START when the tab is actually shown.
    // `resume()` returns early when already running and `pause()` is
    // idempotent, so a tab that mounts hidden and is then shown starts once.
    if (document.visibilityState !== "hidden") controller.start();
    const onVisibility = () =>
      document.visibilityState === "hidden" ? controller.pause() : controller.resume();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
      controllerRef.current = null;
    };
    // `eventIds` and `initialCockpit` are read inside the stream closures.
    // `idsKey` is `eventIds`' stable identity (a fresh array arrives on every
    // server render); `initialCockpit` is deliberately NOT a dependency — it is
    // only consulted on the `start` trigger, which fires once per controller,
    // and re-creating four streams because the server re-rendered would abort
    // an in-flight status poll mid-print.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOf, idsKey]);

  /** Every child mutation lands here: one immediate status read and one
   *  immediate cockpit GET, so the sheet and the chips agree without waiting
   *  out a poll interval. */
  const onChanged = useCallback(async () => {
    controllerRef.current?.refresh("status");
    controllerRef.current?.refresh("cockpit");
  }, []);

  // The same custom-DOM-event idiom EarningsRowChips already dispatches on a
  // skip / un-skip. router.refresh() re-renders the SERVER rows but never
  // re-runs a client fetch, so without this the live layer disagreed with the
  // Hub for up to a full poll interval after a mutation.
  useEffect(() => {
    const handler = () => void onChanged();
    window.addEventListener("earnings-data-changed", handler);
    return () => window.removeEventListener("earnings-data-changed", handler);
  }, [onChanged]);

  // Start the client clock. Its own effect, not the tick's, so the first real
  // `nowMs` lands whether or not anything is counting down.
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  // 1 s countdown tick, and ONLY while something is upcoming — the cockpit's
  // own rule. Recursive setTimeout so a slow frame cannot queue a backlog.
  const hasUpcoming = cockpit?.nextRelease != null;
  useEffect(() => {
    if (!hasUpcoming) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      setNowMs(Date.now());
      timer = setTimeout(tick, 1_000);
    };
    timer = setTimeout(tick, 1_000);
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [hasUpcoming]);

  // Belt-and-braces against the browser's default drop behaviour, moved from
  // the deleted panel: a file dropped ANYWHERE outside a card's own handler
  // makes the browser NAVIGATE to that file, tearing the page — and this
  // surface exists for the two minutes around a print, when navigating away is
  // the most expensive thing the desk can accidentally do.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);
    return () => {
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  const printByEvent = useMemo(() => {
    const out: Record<number, PrintStatusEntry> = {};
    for (const p of prints) if (p.eventId !== undefined) out[p.eventId] = p;
    return out;
  }, [prints]);

  const value = useMemo<HubLiveValue>(
    () => ({
      printByEvent,
      cockpitByEvent: cockpit?.rowsByEvent ?? {},
      prepareByEvent: prepare,
      nowMs,
      statusError,
      onChanged,
    }),
    [printByEvent, cockpit, prepare, nowMs, statusError, onChanged],
  );

  return (
    <HubLiveContext.Provider value={value}>
      {children}
      <LivePrintsOutsideWeek prints={orphanPrints(printByEvent, eventIds)} />
      {/* ONE line, once. The status poll feeds every row, so putting this on
          each expansion would print the same sentence N times for a single
          failed request. It says what stopped rather than what is missing: the
          rows keep their last good sheet, they are just no longer moving. */}
      {statusError && (
        <p className="px-5 py-2 text-[11px] font-mono text-down">
          Print watch is not updating — {statusError} The rows below hold the last reading.
        </p>
      )}
    </HubLiveContext.Provider>
  );
}

/**
 * One armed Hub row's live-print expansion (M-F6, M-F13).
 *
 * A SEPARATE top-level component, never nested inside the provider's body —
 * a component defined in another component's body is a new type on every
 * render and remounts its whole subtree, which here would tear down an
 * in-flight upload.
 *
 * There is no grid to span: `.earnings-hub-desktop` is `display:block`, the
 * per-day wrapper is a plain `<div>` and the CSS grid lives on each ROW, so a
 * sibling rendered after the row is already full width and `col-span-full`
 * would be inert.
 */
export function LivePrintSlot({
  eventId,
  symbol,
  armed,
}: {
  eventId: number;
  symbol: string;
  armed: boolean;
}) {
  const live = useHubLive();
  const print = live?.printByEvent[eventId] ?? null;
  const prevRef = useRef<ExpansionSnapshot | null>(null);
  const [manual, setManual] = useState<ManualToggle>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // IrPageField reads the stored row in an effect keyed on `onError`, so these
  // must be identity-stable or the read re-runs on every poll tick.
  const onNote = useCallback((text: string) => {
    setNote(text);
    setFieldError(null);
  }, []);
  const onError = useCallback((text: string) => {
    setFieldError(text);
  }, []);

  // The stored preference is per PRINT, so it is read when the print id
  // appears or changes — never once at mount.
  const printId = print?.printId ?? null;
  useEffect(() => {
    if (printId === null) return;
    const stored = readManual(printId);
    setManual(stored === null ? null : { printId, open: stored });
  }, [printId]);

  useEffect(() => {
    if (!print) {
      // The print left the payload entirely (expired out of the window,
      // re-homed by a merge, or the event was deleted). Nothing about the old
      // subject may survive into whatever appears next.
      prevRef.current = null;
      setManual(null);
      setOpen(false);
      return;
    }
    const next = snapshotOf(print);
    // CAPTURED BEFORE the ref is overwritten — this is the whole bug: comparing
    // against prevRef.current AFTER writing it makes the comparison trivially
    // true, so a re-homed row kept the old print's open state.
    const prevPrintId = prevRef.current?.printId ?? null;
    const decided = deriveExpansion(prevRef.current, next, manual);
    prevRef.current = next;
    setOpen((was) => nextOpenState({ was, decided, prevPrintId, next, manual }));
  }, [print, manual]);

  if (!armed && !print) return null;

  const toggle = () => {
    const next = !open;
    if (print) {
      // The preference belongs to this print, and only this print — a date
      // correction that re-homes the row must not inherit it.
      setManual({ printId: print.printId, open: next });
      writeManual(print.printId, next);
    }
    setOpen(next);
  };

  const stateChip = print ? printStateLabel(print.state) : null;
  // `|| Date.now()`, not `??`: nowMs is 0 until the client clock starts. A
  // print can only be here after a client poll has landed, so the fallback is
  // unreachable in practice and never reaches server-rendered markup.
  const headline = print
    ? `live print · ${stateChip!.text} · ${windowText(print.effectiveWindow ?? null, live?.nowMs || Date.now())}`
    : "armed — the watch window opens automatically ahead of the release";

  return (
    <div className="px-5 py-2 border-b border-edge bg-canvas">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <p className="text-[12px] font-mono text-ink-dim">{headline}</p>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="relative text-[11px] font-mono underline text-ink-dim hover:text-ink pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1"
          title={open ? "Collapse this print" : "Open the live print sheet for this row"}
        >
          {open ? "collapse" : "expand"}
        </button>
      </div>
      {open && print && (
        <LivePrintRow
          print={print}
          prepareSteps={live?.prepareByEvent[eventId]}
          onChanged={live?.onChanged ?? NO_REFRESH}
        />
      )}
      {open && !print && (
        <div className="mt-2 space-y-1.5">
          {/* Before the window opens there is no sheet to show — what the desk
              CAN still do is the two things that decide whether the print is
              acquired at all: give the symbol an IR page, and see which prepare
              steps are still waiting.

              A calendar event may carry a null symbol (`CalendarEvent.symbol`
              is nullable — a hand-added row saved without one). The sources
              route is keyed BY symbol, so there is nothing to read or write for
              such a row: say so rather than render a field that would 400. */}
          {symbol === "" ? (
            <p className="text-[12px] text-ink-faint italic">
              This event has no ticker, so there is no IR page to configure — add the symbol on the
              row above first.
            </p>
          ) : (
            <IrPageField symbol={symbol} onNote={onNote} onError={onError} />
          )}
          <PrepareStatus steps={live?.prepareByEvent[eventId]} />
          {fieldError && <p className="text-[12px] text-down">{fieldError}</p>}
          {note && !fieldError && <p className="text-[12px] text-up">{note}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * Live prints whose event is not in the week the Hub is showing (Codex round 1
 * #14 / F-S10). Without this they are invisible from Today: the print-watch
 * panel that used to list every active print is deleted in task 10, and the
 * Hub only renders the current week's events. Slice C's forced window is what
 * puts one here — a date correction or a late filer.
 *
 * A SEPARATE top-level component (never nested — the remount trap), taking its
 * rows as a prop so `react-dom/server` can render it in a test. The status
 * payload carries no event DATE (verified: the status route's mapper returns
 * printId, eventId, symbol, state, sources, coverage, the window fields,
 * goRequest, lines, documents, documentRoads, read, activeRead, lastAttempt,
 * callouts — and F may not edit that route, E owns it), so the line names the
 * symbol, the state and the effective window instead of inventing a date. That
 * is a recorded residual, not a gap to paper over with a client-side lookup.
 */
export function LivePrintsOutsideWeek({ prints }: { prints: PrintStatusEntry[] }) {
  if (prints.length === 0) return null;
  return (
    <div className="mt-3 border-t border-edge px-5 py-3">
      <h3 className="text-[11px] uppercase tracking-wider text-ink-faint whitespace-nowrap!">
        Live prints outside this week
      </h3>
      {prints.map((p) => (
        <div key={p.printId} className="mt-2">
          <p className="text-[12px] font-mono text-ink-dim">
            {p.symbol} · {printStateLabel(p.state).text}
            {p.effectiveWindow ? ` · ${windowText(p.effectiveWindow, Date.now())}` : ""}
          </p>
          <LivePrintSlot eventId={p.eventId!} symbol={p.symbol} armed />
        </div>
      ))}
    </div>
  );
}
