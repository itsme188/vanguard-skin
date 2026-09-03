"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Chip, type ChipTone } from "@/app/dashboard/components/Chip";
import { Money } from "@/lib/privacy/components";
import { EarningsEmailViewer } from "@/app/dashboard/components/EarningsEmailViewer";
import { BogeysEditModal } from "./BogeysEditModal";
import { CallNoteModal } from "./CallNoteModal";
import apiFetch from "@/lib/http/apiFetch";

const POLL_MS = 60_000;

// Mirrors CockpitPayload / CockpitRow from lib/queries/earnings-cockpit.ts.
interface Stages {
  preview: string;
  released: { state: string; releaseInstant: string | null };
  actual: string;
  reaction: { state: string; source: string | null; readyAt: string | null };
  recap: string;
}
interface CockpitIntel {
  impliedMovePct: number | null;
  impliedMethod: "sheet" | "straddle" | "iv_approx" | null;
  sheetSourceLabel: string | null;
  histAvgAbsMovePct: number | null;
  histBeatCount: number;
  histQuarterCount: number;
}
interface Row {
  eventId: number;
  symbol: string;
  securityId: number | null;
  eventDate: string;
  eventTime: string | null;
  releaseTime: string | null;
  symbolStatus: "held" | "watchlist" | "armed";
  consensus: string;
  actual: string | null;
  stages: Stages;
  netExposure: number;
  isTopExposure: boolean;
  hasCallNote: boolean;
  carryover: boolean;
  intel: CockpitIntel | null;
}
interface Payload {
  generatedAt: string;
  nextRelease: { eventId: number; symbol: string; releaseInstant: string } | null;
  lanes: { bmo: Row[]; amc: Row[]; unknown: Row[] };
  carryover: Row[];
  skippedRows: number;
}

const SEND_TONES: Record<string, ChipTone> = {
  sent: "up",
  "sent-by-cloud": "info",
  "in-flight": "warn",
  skipped: "neutral",
  pending: "neutral",
  waiting: "neutral",
  missed: "down",
  blocked: "down",
  captured: "up",
  implausible: "warn",
};
const SEND_GLYPHS: Record<string, string> = {
  sent: "✓",
  "sent-by-cloud": "☁",
  "in-flight": "…",
  skipped: "–",
  pending: "",
  waiting: "",
  missed: "✗",
  blocked: "✗",
  captured: "✓",
  implausible: "⚠",
};

function chipFor(label: string, state: string): { tone: ChipTone; text: string } {
  const glyph = SEND_GLYPHS[state] ?? "";
  return { tone: SEND_TONES[state] ?? "neutral", text: glyph ? `${label} ${glyph}` : label };
}

function fmtCountdown(msLeft: number): string {
  if (msLeft <= 0) return "now";
  const totalMin = Math.floor(msLeft / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const s = Math.floor((msLeft % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function EarningsCockpit() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [stale, setStale] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // GET is a side-effect-free read of already-computed intel (#35 task 5).
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/earnings/cockpit");
      const json = await res.json();
      if (!alive.current) return;
      if (res.ok && json.success) {
        setPayload(json.data);
        setStale(false);
      } else {
        setStale(true);
      }
    } catch {
      if (!alive.current) return;
      setStale(true); // keep last good payload; never blank a rendered cockpit
    }
  }, []);

  // POST refreshes intel (implied-move / straddle rows) then returns the
  // decorated payload. The refresh is the write that used to ride the GET;
  // it's TTL-guarded server-side (≤1 refresh per event per 30 min). Routed
  // through apiFetch (#35 task 9-12) since it's a mutating call.
  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch("/api/earnings/cockpit", { method: "POST" });
      const json = await res.json();
      if (!alive.current) return;
      if (res.ok && json.success) {
        setPayload(json.data);
        setStale(false);
      }
      // A failed refresh keeps the last good payload; load()'s read still runs.
    } catch {
      /* keep last good payload */
    }
  }, []);

  useEffect(() => {
    // Instant paint from cache, then refresh intel in the background.
    void load();
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load, refresh]);

  // Immediate refetch when an earnings mutation happens elsewhere on the
  // page (add / delete / skip in the EarningsHub). Those handlers call
  // router.refresh(), which re-renders the server-rendered Hub but never
  // re-runs this component's client fetch — so the cockpit disagreed with
  // the Hub for up to a POLL_MS minute after a delete (deep-QA 2026-07-13).
  // Same custom-DOM-event idiom as toggle-mobile-chat / open-settings.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener("earnings-data-changed", onChanged);
    return () => window.removeEventListener("earnings-data-changed", onChanged);
  }, [load]);

  // 1s countdown tick — only while something is upcoming.
  const hasUpcoming = !!payload?.nextRelease;
  useEffect(() => {
    if (!hasUpcoming) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasUpcoming]);

  if (!payload) return null;
  const { lanes, carryover, nextRelease } = payload;
  const total = lanes.bmo.length + lanes.amc.length + lanes.unknown.length + carryover.length;
  if (total === 0) return null;

  return (
    <section className="rounded-xl bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-ink-dim">
          Earnings day
          <span className="ml-2 text-ink-faint">
            {total} reporter{total === 1 ? "" : "s"}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          {nextRelease && (
            <span className="font-mono text-[12px] text-gold-ink">
              {nextRelease.symbol} in {fmtCountdown(Date.parse(nextRelease.releaseInstant) - nowMs)}
            </span>
          )}
          {stale && <span className="text-[11px] italic text-ink-faint">stale, retrying…</span>}
        </div>
      </div>

      {carryover.length > 0 && (
        <Lane label="yesterday — unfinished" rows={carryover} tint onChanged={load} />
      )}
      {lanes.bmo.length > 0 && <Lane label="before the open" rows={lanes.bmo} onChanged={load} />}
      {lanes.amc.length > 0 && <Lane label="after the close" rows={lanes.amc} onChanged={load} />}
      {lanes.unknown.length > 0 && (
        <Lane label="time unknown" rows={lanes.unknown} onChanged={load} />
      )}
    </section>
  );
}

function Lane({
  label,
  rows,
  tint,
  onChanged,
}: {
  label: string;
  rows: Row[];
  tint?: boolean;
  onChanged: () => void;
}) {
  return (
    <div className={`mt-3 rounded-lg ${tint ? "bg-amber-500/10 p-2" : ""}`}>
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</div>
      <ul className="mt-1 space-y-2">
        {rows.map((row) => (
          <CockpitRowView key={row.eventId} row={row} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

function CockpitRowView({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const [viewerPhase, setViewerPhase] = useState<"preview" | "recap" | null>(null);
  const [actualsOpen, setActualsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const preview = chipFor("pre", row.stages.preview);
  const actual = chipFor("act", row.stages.actual);
  const reaction =
    row.stages.reaction.state === "captured"
      ? { tone: "up" as ChipTone, text: `rxn ✓${row.stages.reaction.source ? ` ${row.stages.reaction.source}` : ""}` }
      : { tone: "neutral" as ChipTone, text: "rxn" };
  const recap = chipFor("rec", row.stages.recap);
  const released = row.stages.released;
  const releasedChip =
    released.state === "released"
      ? { tone: "gold" as ChipTone, text: "released" }
      : released.state === "upcoming"
        ? { tone: "neutral" as ChipTone, text: row.releaseTime ?? row.eventTime ?? "—" }
        : { tone: "neutral" as ChipTone, text: row.eventTime ?? "time?" };

  const previewClickable = row.stages.preview === "sent" || row.stages.preview === "sent-by-cloud";
  const recapClickable = row.stages.recap === "sent" || row.stages.recap === "sent-by-cloud";
  const blocked = row.stages.actual === "blocked";
  const showNote = released.state === "released";

  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex min-w-0 items-center gap-1.5">
        {row.isTopExposure && (
          <span className="text-gold" title="Largest exposure in this lane">◆</span>
        )}
        {row.securityId ? (
          <Link
            href={`/dashboard/security/${row.securityId}`}
            className="font-mono text-[13px] font-semibold text-gold-ink hover:underline"
          >
            {row.symbol}
          </Link>
        ) : (
          <span className="font-mono text-[13px] font-semibold text-ink">{row.symbol}</span>
        )}
        <Chip
          tone={row.symbolStatus === "held" ? "up" : row.symbolStatus === "watchlist" ? "info" : "neutral"}
          size="xs"
          uppercase
        >
          {row.symbolStatus === "held" ? "held" : row.symbolStatus === "watchlist" ? "watch" : "armed"}
        </Chip>
        {row.netExposure !== 0 && (
          <span className="text-[12px] text-ink-dim">
            <Money value={row.netExposure} signed />
          </span>
        )}
      </span>

      {row.intel && (row.intel.impliedMovePct != null || row.intel.histAvgAbsMovePct != null) && (
        <span className="text-[12px] text-ink-dim whitespace-nowrap">
          {row.intel.impliedMovePct != null && (
            <span
              title={
                row.intel.impliedMethod === "sheet"
                  ? `Analyst-sheet expected move${row.intel.sheetSourceLabel ? ` — ${row.intel.sheetSourceLabel}` : ""}`
                  : row.intel.impliedMethod === "straddle"
                    ? "Options-implied move (ATM straddle)"
                    : "Options-implied move (IV approximation)"
              }
            >
              impl {row.intel.impliedMethod === "iv_approx" ? "~" : ""}±{row.intel.impliedMovePct.toFixed(1)}%
              {row.intel.impliedMethod === "sheet" && " (sheet)"}
            </span>
          )}
          {row.intel.impliedMovePct != null && row.intel.histAvgAbsMovePct != null && " · "}
          {row.intel.histAvgAbsMovePct != null && (
            <>
              hist ±{row.intel.histAvgAbsMovePct.toFixed(1)}%
              {row.intel.histQuarterCount > 0 && ` (${row.intel.histBeatCount}/${row.intel.histQuarterCount})`}
            </>
          )}
        </span>
      )}

      <span className="text-[12px] text-ink-faint">
        {row.consensus && <>cons {row.consensus}</>}
        {row.actual && <> → <span className="text-ink">{row.actual}</span></>}
      </span>

      <span className="ml-auto flex flex-wrap items-center gap-1">
        <Chip tone={releasedChip.tone} size="xs">{releasedChip.text}</Chip>
        <ChipButton
          chip={preview}
          onClick={previewClickable ? () => setViewerPhase("preview") : undefined}
        />
        <ChipButton chip={actual} onClick={blocked ? () => setActualsOpen(true) : undefined} />
        <Chip tone={reaction.tone} size="xs">{reaction.text}</Chip>
        <ChipButton
          chip={recap}
          onClick={recapClickable ? () => setViewerPhase("recap") : undefined}
        />
        {showNote && (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="relative inline-flex items-center rounded-full bg-raised px-2 py-0.5 text-[11px] font-medium text-ink-dim hover:text-ink active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
          >
            {row.hasCallNote ? "✎ note" : "+ note"}
          </button>
        )}
      </span>

      {viewerPhase && (
        <EarningsEmailViewer
          eventId={row.eventId}
          phase={viewerPhase}
          open={true}
          onClose={() => setViewerPhase(null)}
        />
      )}
      <BogeysEditModal
        eventId={row.eventId}
        symbol={row.symbol}
        open={actualsOpen}
        onClose={() => {
          setActualsOpen(false);
          onChanged();
        }}
      />
      <CallNoteModal
        eventId={row.eventId}
        symbol={row.symbol}
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        onSaved={onChanged}
      />
    </li>
  );
}

function ChipButton({
  chip,
  onClick,
}: {
  chip: { tone: ChipTone; text: string };
  onClick?: () => void;
}) {
  if (!onClick) return <Chip tone={chip.tone} size="xs">{chip.text}</Chip>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
    >
      <Chip tone={chip.tone} size="xs" className="cursor-pointer">
        {chip.text}
      </Chip>
    </button>
  );
}
