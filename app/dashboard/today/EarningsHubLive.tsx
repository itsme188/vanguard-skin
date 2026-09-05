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
 * THE RESPONSIVE TWINS (fix round 2, review I2). `EarningsHub` renders BOTH a
 * desktop grid row and a mobile card row for every event and lets CSS hide one,
 * so every client leaf under it mounts TWICE. That is a four-times-fixed hazard
 * in this subtree (see `EarningsRowChips`' `offsetParent` guard), and it bites
 * a live-print expansion in two ways: per-row open state kept inside the slot
 * DIVERGES between the twins the moment the desk toggles one (the chat rail
 * switches which twin is visible at 1280 with no remount — M-F14's band), and
 * the expansion's mount effects fire their reads twice. Both are closed here:
 * the open state lives in the PROVIDER, keyed by event, so the twins cannot
 * disagree; and the expansion BODY renders only in the twin that is actually
 * on screen, following the precedent the chip row already set.
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
import {
  createPollController,
  type PollController,
  type StreamSpec,
} from "./hub-live/poll-controller";
import { COOL_POLL_MS, ENSURE_INTERVAL_MS, HOT_POLL_MS, printStateLabel, windowText } from "./live-print/helpers";
import type {
  CockpitPayloadWire,
  CockpitRowWire,
  PrepareStepWire,
  PrintStatusEntry,
} from "./hub-live/types";

/** The cockpit and prepare streams both run on a flat one-minute cadence. */
const SLOW_POLL_MS = 60_000;

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
 * Does anything currently on screen need a ticking clock? (fix round 2, review
 * I1.)
 *
 * This used to be `cockpit.nextRelease != null`, which is wrong now and was
 * only ever right by accident. `nextRelease` is computed from TODAY's rows
 * (`lib/queries/earnings-cockpit.ts`), but M-F5 widened the payload and the
 * chips render a countdown for every row in the WEEK. So on a Monday with
 * nothing reporting today and three Wednesday rows, the old gate never started
 * the tick at all: every Wednesday countdown froze at its mount value for the
 * whole session, and so did `LivePrintSlot`'s headline clock — which decides
 * "window opens 16:05" vs "window open until 16:35" and could therefore print a
 * sentence that contradicts the state chip beside it.
 *
 * The gate walks the rows that are actually RENDERED, plus the live prints,
 * which are the surface where a stale clock costs the most. It still stops: a
 * week whose every release has happened, with no live print left, counts down
 * to nothing and the tick is torn down.
 */
export function hasLiveCountdown(
  rowsByEvent: Record<number, CockpitRowWire> | undefined,
  printCount: number,
): boolean {
  if (printCount > 0) return true;
  for (const row of Object.values(rowsByEvent ?? {})) {
    if (row.stages.released.state === "upcoming" && row.stages.released.releaseInstant !== null) {
      return true;
    }
  }
  return false;
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

/** What `buildHubStreams` needs from the provider. Everything is data or a
 *  callback, and the fetch arrives through the controller — so the four streams
 *  are testable end to end with no DOM (fix round 2, review I4). */
export interface HubStreamArgs {
  weekOf: string;
  eventIds: number[];
  /** True when the server handed a payload down, in which case the cockpit's
   *  `start` run must fetch NOTHING — the server render is the freshest thing
   *  there is. */
  hasInitialCockpit: boolean;
  /** Read (never closed over by value) so a cadence change needs no restart. */
  printsRef: { current: PrintStatusEntry[] };
  onStatus: (rows: PrintStatusEntry[]) => void;
  onStatusError: (message: string) => void;
  onCockpit: (payload: CockpitPayloadWire) => void;
  onPrepare: (rows: Record<number, PrepareStepWire[]>) => void;
}

/**
 * The four streams the Hub polls (M-F3), as pure data.
 *
 * Extracted from the provider body so the wiring can be ASSERTED rather than
 * pinned by source regex: which URL, which METHOD per trigger, what a failure
 * does. The POST/GET split on the cockpit is the whole point of `trigger` —
 * POST is the intel REFRESH (it writes, TTL-guarded server-side at one refresh
 * per event per 30 min), GET is a cheap read — and a regex over the source
 * cannot tell an inverted ternary from a correct one.
 */
export function buildHubStreams(h: HubStreamArgs): Array<StreamSpec<unknown>> {
  return [
    {
      name: "status",
      intervalMs: () => statusIntervalMs(h.printsRef.current),
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
      onResult: (rows) => h.onStatus(rows as PrintStatusEntry[]),
      onError: (err) =>
        h.onStatusError(
          err instanceof Error ? err.message : "Could not reach the server for print-watch status.",
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
        // Non-blocking by design — /ensure only arms the watcher loops, so a
        // failure is never a user-facing error (there is deliberately no
        // `onError` below). But a silently, persistently failing /ensure means
        // the watcher has stopped being kept alive, so it reaches the console.
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
      intervalMs: () => SLOW_POLL_MS,
      run: async (signal, fetchImpl, trigger) => {
        // A server-rendered payload is the freshest thing there is, so the
        // first run after mount fetches NOTHING. A mutation (`refresh`) or a
        // tab coming back (`resume`) wants a cheap read. Only the 60-second
        // timer POSTs, because POST is the intel REFRESH — it writes, and
        // is TTL-guarded server-side at one refresh per event per 30 min.
        if (trigger === "start" && h.hasInitialCockpit) return null;
        const url = `/api/earnings/cockpit?weekOf=${encodeURIComponent(h.weekOf)}`;
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
      onResult: (p) => h.onCockpit(p as CockpitPayloadWire),
      // Keep the last good payload; never blank a rendered chip strip.
      onError: () => undefined,
    },
    {
      name: "prepare",
      intervalMs: () => SLOW_POLL_MS,
      run: async (signal, fetchImpl) => {
        if (h.eventIds.length === 0) return {};
        const res = await fetchImpl(`/api/earnings/worksheet?eventIds=${h.eventIds.join(",")}`, {
          signal,
        });
        const data = (await res.json().catch(() => null)) as
          | { success?: boolean; data?: { prepare: Record<number, PrepareStepWire[]> } }
          | null;
        if (!res.ok || !data?.success || !data.data) throw new Error("prepare read failed");
        return data.data.prepare;
      },
      onResult: (p) => h.onPrepare(p as Record<number, PrepareStepWire[]>),
      onError: () => undefined,
    },
  ];
}

export interface HubLiveValue {
  printByEvent: Record<number, PrintStatusEntry>;
  cockpitByEvent: Record<number, CockpitRowWire>;
  prepareByEvent: Record<number, PrepareStepWire[]>;
  /** Per EVENT, not per slot — the two responsive twins share one truth
   *  (review I2). Absent means closed. */
  openByEvent: Record<number, boolean>;
  /** Flip one row. `printId` is the print the preference belongs to, or null
   *  for an armed row whose window has not opened yet (nothing to remember). */
  toggleRow: (eventId: number, printId: number | null) => void;
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
      streams: buildHubStreams({
        weekOf,
        eventIds,
        hasInitialCockpit: initialCockpit !== null,
        printsRef,
        onStatus: (rows) => {
          printsRef.current = rows;
          setPrints(rows);
          setStatusError(null);
        },
        onStatusError: setStatusError,
        onCockpit: setCockpit,
        onPrepare: setPrepare,
      }),
    });
    controllerRef.current = controller;
    // A tab restored in the background must not fire four requests nobody is
    // looking at. Create the controller either way — the visibility handler
    // below is what starts it — but only START when the tab is actually shown.
    // `resume()` returns early when already running and `pause()` is
    // idempotent, so a tab that mounts hidden and is then shown starts once.
    if (document.visibilityState !== "hidden") {
      controller.start();
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        controller.pause();
        // Nothing is polling any more, so a stale "print watch is not
        // updating" banner would outlive the condition it describes and be
        // the first thing the desk reads on returning (review M3).
        setStatusError(null);
      } else {
        controller.resume();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      controller.stop();
      controllerRef.current = null;
      setStatusError(null);
    };
    // `eventIds` and `initialCockpit` are read inside the stream closures.
    // `idsKey` is `eventIds`' stable identity (a fresh array arrives on every
    // server render); `initialCockpit` is deliberately NOT a dependency — it is
    // only consulted on the `start` trigger, which fires once per controller,
    // and re-creating four streams because the server re-rendered would abort
    // an in-flight status poll mid-print.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekOf, idsKey]);

  /**
   * A FRESH server payload wins (fix round 2, review I3).
   *
   * `useState(initialCockpit)` reads its argument once, so every later server
   * render's payload was silently dropped. That matters because five of the
   * Hub's mutation paths — the bogeys modal, the date chip, the refresh button
   * and the bogeys upload — call `router.refresh()` and nothing else: the RSC
   * re-render recomputes the whole cockpit, and without this the stage chips,
   * the intel line and the countdown kept the pre-mutation payload for up to a
   * full minute. Saving bogeys is the sharpest case, since it changes the
   * sheet-sourced expected move the intel line renders.
   *
   * It must not clobber a FRESHER client payload, though: a 60-second POST that
   * landed after this server render is newer than the render. `generatedAt` is
   * `new Date().toISOString()` on both sides — one format, so a lexicographic
   * compare is a chronological one.
   */
  useEffect(() => {
    if (!initialCockpit) return;
    setCockpit((current) =>
      current !== null && current.generatedAt > initialCockpit.generatedAt
        ? current
        : initialCockpit,
    );
  }, [initialCockpit]);

  /** Every child mutation lands here: one immediate status read and one
   *  immediate cockpit GET, so the sheet and the chips agree without waiting
   *  out a poll interval.
   *
   *  It AWAITS both (R-F24). Children do `await onChanged()` inside a `try` and
   *  drop their busy state in the `finally`, so resolving when the requests were
   *  merely ISSUED would re-arm an accept button while the row still showed the
   *  pre-mutation sheet — a control that looks ready before its effect is
   *  visible is what invites the second click. In parallel, not serially: two
   *  independent requests, and the desk is waiting on the slower one, not on
   *  their sum. `PollController.refresh` never rejects, so no `catch` belongs
   *  here. */
  const onChanged = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    await Promise.all([controller.refresh("status"), controller.refresh("cockpit")]);
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

  const printByEvent = useMemo(() => {
    const out: Record<number, PrintStatusEntry> = {};
    for (const p of prints) if (p.eventId !== undefined) out[p.eventId] = p;
    return out;
  }, [prints]);

  // 1 s countdown tick, and ONLY while something on screen is still counting
  // down. Recursive setTimeout so a slow frame cannot queue a backlog.
  const hasUpcoming = useMemo(
    () => hasLiveCountdown(cockpit?.rowsByEvent, prints.length),
    [cockpit, prints.length],
  );
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

  /**
   * WHICH ROWS ARE EXPANDED — one map, in the provider (review I2).
   *
   * This used to live inside each `LivePrintSlot`, which meant the desktop and
   * mobile twins of the same row held SEPARATE copies: toggling one wrote only
   * its own state, and `app/globals.css` swaps which twin is visible on the
   * chat rail's attribute with no remount, so collapsing a print at 1280 and
   * opening the rail brought it straight back expanded. Keying the map by event
   * makes the twins two views of one decision.
   *
   * The reducer is unchanged and still pure (`hub-live/expansion.ts`); it just
   * runs ONCE per print here instead of once per twin. `openRef` mirrors the
   * state so the walk can read the current value without listing it as a
   * dependency, and `applyOpen` bails when nothing moved, so a poll that
   * changes no expansion re-renders nothing.
   */
  const [openByEvent, setOpenByEvent] = useState<Record<number, boolean>>({});
  const openRef = useRef<Record<number, boolean>>({});
  /** eventId -> the desk's manual choice about the print now on that row. */
  const manualRef = useRef<Record<number, ManualToggle>>({});
  /** eventId -> what that row's print looked like on the previous payload. */
  const snapRef = useRef<Record<number, ExpansionSnapshot>>({});

  const applyOpen = useCallback((next: Record<number, boolean>) => {
    const prev = openRef.current;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    let changed = false;
    for (const key of keys) {
      const id = Number(key);
      if ((prev[id] ?? false) !== (next[id] ?? false)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    openRef.current = next;
    setOpenByEvent(next);
  }, []);

  useEffect(() => {
    const next: Record<number, boolean> = { ...openRef.current };
    // A row whose print left the payload entirely (expired out of the window,
    // re-homed by a merge, or the event deleted). Nothing about the old subject
    // may survive into whatever appears next.
    for (const key of Object.keys(snapRef.current)) {
      const id = Number(key);
      if (printByEvent[id]) continue;
      delete snapRef.current[id];
      delete manualRef.current[id];
      next[id] = false;
    }
    for (const [key, print] of Object.entries(printByEvent)) {
      const id = Number(key);
      const snap = snapshotOf(print);
      // CAPTURED BEFORE the ref is overwritten — comparing against the ref
      // after writing it makes the comparison trivially true, so a re-homed row
      // would keep the old print's open state.
      const prevSnap = snapRef.current[id] ?? null;
      // The stored preference is per PRINT, so it is read when the print id
      // appears or changes — never once at mount.
      if (prevSnap === null || prevSnap.printId !== snap.printId) {
        const stored = readManual(snap.printId);
        manualRef.current[id] = stored === null ? null : { printId: snap.printId, open: stored };
      }
      const manual = manualRef.current[id] ?? null;
      const decided = deriveExpansion(prevSnap, snap, manual);
      snapRef.current[id] = snap;
      next[id] = nextOpenState({
        was: next[id] ?? false,
        decided,
        prevPrintId: prevSnap?.printId ?? null,
        next: snap,
        manual,
      });
    }
    applyOpen(next);
  }, [printByEvent, applyOpen]);

  const toggleRow = useCallback(
    (eventId: number, printId: number | null) => {
      const open = !(openRef.current[eventId] ?? false);
      if (printId !== null) {
        // The preference belongs to this print, and only this print — a date
        // correction that re-homes the row must not inherit it.
        manualRef.current[eventId] = { printId, open };
        writeManual(printId, open);
      }
      applyOpen({ ...openRef.current, [eventId]: open });
    },
    [applyOpen],
  );

  const value = useMemo<HubLiveValue>(
    () => ({
      printByEvent,
      cockpitByEvent: cockpit?.rowsByEvent ?? {},
      prepareByEvent: prepare,
      openByEvent,
      toggleRow,
      nowMs,
      statusError,
      onChanged,
    }),
    [printByEvent, cockpit, prepare, openByEvent, toggleRow, nowMs, statusError, onChanged],
  );

  return (
    <HubLiveContext.Provider value={value}>
      {children}
      <LivePrintsOutsideWeek prints={orphanPrints(printByEvent, eventIds)} nowMs={nowMs} />
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
 *
 * Whether the row is OPEN is the provider's, not this component's — see the
 * responsive-twin note at the top of the file. What stays local is the body's
 * visibility check, because that is a fact about THIS instance.
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
  const [note, setNote] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  /** Only used when this slot renders OUTSIDE the provider — there is no shared
   *  map to write to then, and an inert toggle would be a lie. */
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const open = live ? (live.openByEvent[eventId] ?? false) : standaloneOpen;

  // IrPageField reads the stored row in an effect keyed on `onError`, so these
  // must be identity-stable or the read re-runs on every poll tick.
  const onNote = useCallback((text: string) => {
    setNote(text);
    setFieldError(null);
  }, []);
  const onError = useCallback((text: string) => {
    setFieldError(text);
  }, []);

  /**
   * IS THIS THE TWIN THE DESK CAN SEE? (review I2, following the precedent in
   * `EarningsRowChips`.)
   *
   * Both twins of a row are in the DOM at once; CSS hides one. The expansion
   * body mounts `IrPageField`, which reads `GET /api/print-watch/sources` in a
   * mount effect, so rendering it in both fires two identical reads per
   * expansion and two more on every symbol change. `offsetParent` is null
   * whenever any ancestor is `display:none` — a direct structural check with no
   * viewport-width heuristic to keep in sync with the Tailwind breakpoint.
   *
   * It is re-measured on resize AND on the chat rail's `data-chat-rail`
   * attribute, because `app/globals.css` swaps the twins on that attribute
   * "instantly … without page reload" — the M-F14 band, where a one-shot
   * measurement would leave the body mounted in the hidden twin. The
   * subscription deliberately does NOT depend on `open`: measuring only while
   * expanded leaves the reading stale across a rail toggle made while the row
   * was collapsed, and the next expansion would then mount the body in the
   * wrong twin for a frame. It IS skipped for a slot that renders nothing at
   * all, so a week of unarmed rows subscribes to nothing.
   *
   * Starts false so nothing renders before it is measured. Safe: `open` is
   * false on every server render (the map starts empty and a print only ever
   * arrives from a client poll), so this never changes server markup.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const [isVisibleTwin, setIsVisibleTwin] = useState(false);
  const rendered = armed || print !== null;
  useEffect(() => {
    if (!rendered) return;
    const measure = () => {
      const visible = rootRef.current !== null && rootRef.current.offsetParent !== null;
      setIsVisibleTwin((was) => (was === visible ? was : visible));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-chat-rail"],
    });
    return () => {
      window.removeEventListener("resize", measure);
      observer.disconnect();
    };
  }, [rendered]);

  /**
   * Memoised so the sheet does not re-render once a second (review M5). The
   * provider's `nowMs` is part of the context value, so every consumer
   * re-renders on each tick; keeping the element identity stable lets React
   * skip this subtree, which during an upload is the whole print sheet plus its
   * drop zone.
   */
  const prepareSteps = live?.prepareByEvent[eventId];
  const onChanged = live?.onChanged ?? NO_REFRESH;
  const sheet = useMemo(
    () =>
      print ? (
        <LivePrintRow print={print} prepareSteps={prepareSteps} onChanged={onChanged} />
      ) : null,
    [print, prepareSteps, onChanged],
  );

  if (!armed && !print) return null;

  const toggle = () => {
    if (live) live.toggleRow(eventId, print?.printId ?? null);
    else setStandaloneOpen((was) => !was);
  };

  const stateChip = print ? printStateLabel(print.state) : null;
  // The SHARED clock, never `Date.now()` in render — reading the wall clock
  // during a render is impure (`react-hooks/purity`) and, worse, would make
  // this line disagree with the identical line inside `LivePrintRow`. `nowMs`
  // is 0 until the client clock starts, which `windowText` reads as
  // "window opens …"; a print can only be here after a client poll, and the
  // clock effect fires at mount, so that reading is unreachable in practice and
  // never reaches server-rendered markup.
  //
  // COLLAPSED, this line is the only thing the desk can see, so it carries the
  // state and the window. EXPANDED, `LivePrintRow` prints both immediately
  // below it (review M1) — repeating them here says the same thing twice and,
  // before the clock fix, could say it two different ways.
  const headline = print
    ? open
      ? "live print"
      : `live print · ${stateChip!.text} · ${windowText(print.effectiveWindow ?? null, live?.nowMs ?? 0)}`
    : "armed — the watch window opens automatically ahead of the release";

  return (
    <div ref={rootRef} className="px-5 py-2 border-b border-edge bg-canvas">
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
      {open && isVisibleTwin && print && sheet}
      {open && isVisibleTwin && !print && (
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
          <PrepareStatus steps={prepareSteps} />
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
 *
 * `nowMs` is the provider's shared clock (review M4) — this used to read
 * `Date.now()` in render, which is impure and could disagree with the very
 * headline printed one line below it. It is optional so the component stays
 * renderable on its own in a test, and 0 reads as "window opens …", which is
 * unreachable in practice: a non-empty `prints` can only come from a client
 * poll, by which time the clock has started.
 */
export function LivePrintsOutsideWeek({
  prints,
  nowMs,
}: {
  prints: PrintStatusEntry[];
  nowMs?: number;
}) {
  if (prints.length === 0) return null;
  const clock = nowMs ?? 0;
  return (
    <div className="mt-3 border-t border-edge px-5 py-3">
      <h3 className="text-[11px] uppercase tracking-wider text-ink-faint whitespace-nowrap!">
        Live prints outside this week
      </h3>
      {prints.map((p) => (
        <div key={p.printId} className="mt-2">
          <p className="text-[12px] font-mono text-ink-dim">
            {p.symbol} · {printStateLabel(p.state).text}
            {p.effectiveWindow ? ` · ${windowText(p.effectiveWindow, clock)}` : ""}
          </p>
          <LivePrintSlot eventId={p.eventId!} symbol={p.symbol} armed />
        </div>
      ))}
    </div>
  );
}
