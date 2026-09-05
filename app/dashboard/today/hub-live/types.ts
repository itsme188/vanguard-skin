/**
 * The WIRE shapes the Hub's live layer consumes — re-declared CLIENT-SIDE
 * (M-F18).
 *
 * `EarningsHubLive` and its children are `"use client"`, so every module they
 * import is compiled into the browser bundle. `@/lib/queries/earnings-cockpit`
 * is a server module (it takes a `Database.Database` and pulls the whole query
 * stack), so `CockpitRow` / `CockpitPayload` are NOT imported here: their
 * over-the-wire shapes are re-declared, exactly as `PrintWatchPanel.tsx`
 * re-declares the status wire shape today. The same reason keeps
 * `PrintWatchStateWire` a local literal union rather than an import of the
 * server enum — with an assignability pin in
 * `tests/dashboard/hub-live-expansion.test.ts` so a server-side addition fails
 * to compile here rather than drifting silently.
 *
 * What IS imported is type-only, and only from modules that are already legal
 * across the client line:
 *   - `@/lib/print-watch/types` and `@/lib/print-watch/first-pass-types` are on
 *     the client-safe allowlist in `tests/repo/print-watch-import-boundaries.test.ts`;
 *   - `@/lib/earnings/cockpit-stages` is NOT client-safe as a value (it drags
 *     `@stoqey/ib` in through `@/lib/calendar/reaction-snapshot`), but a
 *     type-only import of it is erased before bundling — M-F18 blesses exactly
 *     that shape, and `tests/repo/hub-live-client-boundary.test.ts` enforces it;
 *   - `../FirstPassRead` is itself a client module, and its DTOs are the props
 *     the moved `FirstPassRead` still takes, so re-declaring them would be pure
 *     drift risk.
 *
 * This file contains NO runtime code — every export is a type, so it compiles
 * to an empty module.
 */
import type { EventStages } from "@/lib/earnings/cockpit-stages";
import type { CalloutView } from "@/lib/print-watch/first-pass-types";
import type { PrintWatchLine } from "@/lib/print-watch/types";
import type { ActiveReadDto, FirstPassReadDto, LastAttemptDto } from "../FirstPassRead";

export type { ActiveReadDto, CalloutView, EventStages, FirstPassReadDto, LastAttemptDto };

/** Mirrors `PrintWatchState` (`@/lib/print-watch/types`). Pinned assignable in
 *  both directions by the wire-union test. */
export type PrintWatchStateWire =
  | "scheduled"
  | "window_open"
  | "acquired"
  | "parsed"
  | "expired"
  | "disarmed";

/** The sheet row shape. `@/lib/print-watch/types` is client-safe, and
 *  `reconcile()` — the pure client-side reconciler the sheet renders through —
 *  is typed against this exact interface, so aliasing beats re-declaring. */
export type PrintWatchLineWire = PrintWatchLine;

/** The latest go request against a print (slice C), flattened by the status
 *  route from `GoRequestRow` + its parsed `result_json`. */
export interface GoRequestWire {
  id: number;
  status: "queued" | "claimed" | "done" | "failed";
  attempts: number;
  requestedAt: string;
  result: Array<{ road: string; outcome: string; detail: string }> | null;
}

/** Slice E, contract §2. ABSENT on F's own branch — a payload without it
 *  renders no output buttons and no error. */
export interface PrintOutputsWire {
  printSheet: { enabled: boolean; reason: string | null };
  sendRecap: {
    enabled: boolean;
    reason: string | null;
    state: "unsent" | "in-flight" | "sent" | "sent-by-cloud" | "delivery-unknown";
    providerMessageId: string | null;
  };
}

/** One print off `GET /api/print-watch/status`.
 *
 *  Everything below `lines` is optional on purpose: each field arrived with a
 *  later slice, and a server that predates one must degrade to "not shown"
 *  rather than crash the Hub. `eventId` in particular stays optional as
 *  defence-in-depth — every mutating control keyed on it disables itself with
 *  an explanatory title instead of guessing an id. */
export interface PrintStatusEntry {
  printId: number;
  eventId?: number;
  symbol: string;
  state: PrintWatchStateWire;
  sources: Record<string, string>;
  coverage: string[];
  lines: PrintWatchLineWire[];
  /** doc id → document kind ("edgar-ex99" / "dj-release" / "user-drop" /
   *  "ir-page" / "user-url"), so a conflict row can name WHICH source each
   *  rival number came from. */
  documents?: Record<number, string>;
  /** doc id → the roads that produced it. Sent since slice B; nothing
   *  consumed it until F. */
  documentRoads?: Record<number, Array<{ kind: string; source: string; verdict: string }>>;
  /** Slice C — ISO UTC of the first "Print is live" press, once made. */
  forcedOpenAt?: string | null;
  /** Slice C — ISO UTC written by "Extend 30 min"; presses stack. */
  windowExtendedUntil?: string | null;
  /** Slice C — the ONE effective window, or null for an unresolved print with
   *  no schedule and no go press yet (drop zone only). */
  effectiveWindow?: { start: string; end: string } | null;
  goRequest?: GoRequestWire | null;
  /** Slice D — the newest first-pass read, the in-flight attempt (if any), the
   *  last failure and the verified callouts. */
  read?: FirstPassReadDto | null;
  activeRead?: ActiveReadDto | null;
  lastAttempt?: LastAttemptDto | null;
  callouts?: CalloutView[];
  /** Slice E, contract §2. ABSENT on F's branch — render nothing. */
  outputs?: PrintOutputsWire;
}

/** One prepare step off `GET /api/earnings/worksheet?eventIds=…`
 *  (`PrepareStepRow` in `@/lib/earnings/prepare-armed-event`, which is a
 *  server module — hence the re-declaration). */
export interface PrepareStepWire {
  event_id: number;
  step: string;
  status: "pending" | "claimed" | "done" | "failed";
  input_fingerprint: string | null;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

/** Mirrors `CockpitIntel` (`@/lib/queries/earnings-cockpit`, server-only). */
export interface CockpitIntelWire {
  impliedMovePct: number | null;
  impliedMethod: "sheet" | "straddle" | "iv_approx" | null;
  /** The winning bogey's source_label when impliedMethod === "sheet". */
  sheetSourceLabel: string | null;
  histAvgAbsMovePct: number | null;
  histBeatCount: number;
  histQuarterCount: number;
}

/** Mirrors `CockpitRow` field-for-field. `stages` is the SERVER type, imported
 *  type-only, so slice E's added `"delivery-unknown"` member reaches the chips
 *  the moment E lands instead of needing a second edit here. */
export interface CockpitRowWire {
  eventId: number;
  symbol: string;
  securityId: number | null;
  title: string;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist" | "armed";
  consensus: string;
  actual: string | null;
  stages: EventStages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
  intel: CockpitIntelWire | null;
}

/** Mirrors `CockpitPayload` plus M-F5's `rowsByEvent`, which is what the Hub
 *  keys on (lanes stay TODAY-only, so every existing consumer is untouched). */
export interface CockpitPayloadWire {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: CockpitRowWire[]; amc: CockpitRowWire[]; unknown: CockpitRowWire[] };
  carryover: CockpitRowWire[];
  skippedRows: number;
  rowsByEvent: Record<number, CockpitRowWire>;
}
