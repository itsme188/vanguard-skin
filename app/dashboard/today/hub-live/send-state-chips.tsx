"use client";

/**
 * The cockpit's stage chips, moved into the Hub row (spec §4.6: "The Earnings
 * Cockpit folds into the Earnings Hub rows as chips. The email tri-state
 * helpers move with the chips").
 *
 * The three stage unions come from @/lib/earnings/cockpit-stages as a TYPE-ONLY
 * import: that module value-imports @/lib/calendar/reaction-snapshot and
 * @/lib/calendar/enrichment-runner, which pull @stoqey/ib — a value import from
 * here would not fail a test, it would fail `next build` (R-D20).
 */
import { Chip, type ChipTone } from "@/app/dashboard/components/Chip";
import { Money, PrivateText } from "@/lib/privacy/components";
import { formatPercent } from "@/lib/format";
import type { CockpitRowWire } from "./types";
import type {
  ActualStageState, EmailSendState, PreviewStage, RecapStage,
} from "@/lib/earnings/cockpit-stages";

/**
 * Controller ruling R-F14 (BINDING). Task 6's `types.ts` re-declares `stages`
 * as the server's REAL `EventStages` — sound, but on THIS branch
 * `PreviewStage` / `RecapStage` / `EmailSendState` do not yet carry
 * "delivery-unknown". Slice E adds it in a parallel worktree, and F is
 * required by cross-slice contract §1 to render it TODAY. So the chip maps
 * cannot be keyed off the server unions alone — a `Record<PreviewStage, …>`
 * here could not even have a "delivery-unknown" key.
 *
 * F's display unions are the server's CURRENT members plus the one slice E is
 * adding in a parallel branch (contract §1). F must render "delivery-unknown"
 * before E merges, so the chips cannot key off the server union alone. Once E
 * merges, these collapse to the server unions plus "delivery-unknown" — see
 * the `Record<AllStagesDisplay, …>` typing on `SEND_TONES`/`SEND_GLYPHS`
 * below for the enforcement that keeps this true.
 */
export type PreviewStageDisplay = PreviewStage | "delivery-unknown";
export type RecapStageDisplay = RecapStage | "delivery-unknown";
export type EmailSendStateDisplay = NonNullable<EmailSendState> | "delivery-unknown";

/** Every member the tone/glyph maps must carry a key for. */
type AllStagesDisplay = PreviewStageDisplay | RecapStageDisplay | EmailSendStateDisplay | ActualStageState;

/**
 * The REAL compile-time enforcement lives here, not in a separate bridge type:
 * `Record<AllStagesDisplay, ChipTone>` requires the object literal below to
 * supply a key for every member of the union (the trailing `& Record<string,
 * ChipTone>` only permits extra keys — it does not relax the required ones).
 * `AllStagesDisplay` is built from the server's stage unions, so when slice E
 * widens `PreviewStage`/`RecapStage`/`EmailSendState` with a new member, this
 * object literal is missing that key and fails to compile AT THE MERGE —
 * visibly, instead of a raw state word appearing on the desk's screen at
 * 16:05. Same enforcement on `SEND_GLYPHS` below. The `…Display` unions exist
 * because F must render `"delivery-unknown"` before slice E merges it into
 * the server unions.
 */
export const SEND_TONES: Record<AllStagesDisplay, ChipTone> & Record<string, ChipTone> = {
  sent: "up",
  "sent-by-cloud": "info",
  "in-flight": "warn",
  "delivery-unknown": "warn",
  skipped: "neutral",
  pending: "neutral",
  waiting: "neutral",
  missed: "down",
  blocked: "down",
  captured: "up",
  implausible: "warn",
};

export const SEND_GLYPHS: Record<AllStagesDisplay, string> & Record<string, string> = {
  sent: "✓",
  "sent-by-cloud": "☁",
  "in-flight": "…",
  "delivery-unknown": "?",
  skipped: "–",
  pending: "",
  waiting: "",
  missed: "✗",
  blocked: "✗",
  captured: "✓",
  implausible: "⚠",
};

/** Contract §1, verbatim. */
export const DELIVERY_UNKNOWN_TITLE =
  "The provider's response was never received — check the mailbox or the Resend log for the message id, then resend by hand if needed.";

/** Full-word labels for the states a glyph alone would under-explain — applied
 *  by `stageChips` on top of `chipFor`'s bare output for the chips that have
 *  room for a word (preview/recap), never inside `chipFor` itself. */
const FULL_WORDS: Record<string, string> = { "delivery-unknown": "delivery unknown" };

export function chipFor(label: string, state: string): { tone: ChipTone; text: string; title?: string } {
  const glyph = SEND_GLYPHS[state];
  const known = glyph !== undefined;
  const text = known ? (glyph ? `${label} ${glyph}` : label) : `${label} ${state}`;
  return {
    tone: SEND_TONES[state] ?? "neutral",
    text,
    ...(state === "delivery-unknown" ? { title: DELIVERY_UNKNOWN_TITLE } : {}),
  };
}

/** Appends the full-word label after `chipFor`'s glyph, for the chips wide
 *  enough to carry it (preview/recap). A no-op for every state without a
 *  full-word mapping. */
function withFullWord(
  chip: { tone: ChipTone; text: string; title?: string },
  state: string,
): { tone: ChipTone; text: string; title?: string } {
  const word = FULL_WORDS[state];
  return word ? { ...chip, text: `${chip.text} ${word}` } : chip;
}

export function fmtCountdown(msLeft: number): string {
  if (msLeft <= 0) return "now";
  const totalMin = Math.floor(msLeft / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const s = Math.floor((msLeft % 60_000) / 1000);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Which stage states have a LOCAL body the viewer can show. A cloud send does
 * not (the Worker composed and sent it; the Mac holds no copy), so its chip
 * stays text — a button that opens an empty modal is a lie. A
 * `delivery-unknown` row DOES hold a body (contract §1, R-E14: a fresh send
 * stores what it attempted, a refire keeps what was delivered), which is
 * precisely the row the desk most needs to read before deciding whether to
 * resend by hand.
 */
const VIEWABLE = new Set(["sent", "delivery-unknown"]);

export function stageChips(
  row: CockpitRowWire,
): Array<{ key: string; tone: ChipTone; text: string; title?: string; clickable: "preview" | "recap" | "actuals" | null }> {
  const released = row.stages.released;
  const releasedChip =
    released.state === "released"
      ? { tone: "gold" as ChipTone, text: "released" }
      : released.state === "upcoming"
        ? { tone: "neutral" as ChipTone, text: row.releaseTime ?? row.eventTime ?? "—" }
        : { tone: "neutral" as ChipTone, text: row.eventTime ?? "time?" };
  const reaction =
    row.stages.reaction.state === "captured"
      ? { tone: "up" as ChipTone, text: `rxn ✓${row.stages.reaction.source ? ` ${row.stages.reaction.source}` : ""}` }
      : { tone: "neutral" as ChipTone, text: "rxn" };

  return [
    { key: "released", ...releasedChip, clickable: null },
    {
      key: "preview",
      ...withFullWord(chipFor("pre", row.stages.preview), row.stages.preview),
      clickable: VIEWABLE.has(row.stages.preview) ? "preview" : null,
    },
    { key: "actual", ...chipFor("act", row.stages.actual), clickable: row.stages.actual === "blocked" ? "actuals" : null },
    { key: "reaction", ...reaction, clickable: null },
    {
      key: "recap",
      ...withFullWord(chipFor("rec", row.stages.recap), row.stages.recap),
      clickable: VIEWABLE.has(row.stages.recap) ? "recap" : null,
    },
  ];
}

export function StageChipStrip({
  row,
  onOpen,
}: {
  row: CockpitRowWire;
  onOpen: (what: "preview" | "recap" | "actuals") => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {stageChips(row).map((c) =>
        c.clickable ? (
          <button
            key={c.key}
            type="button"
            title={c.title}
            onClick={() => onOpen(c.clickable!)}
            className="relative active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
          >
            <Chip tone={c.tone} size="xs" className="cursor-pointer">{c.text}</Chip>
          </button>
        ) : (
          <Chip key={c.key} tone={c.tone} size="xs" title={c.title}>{c.text}</Chip>
        ),
      )}
    </span>
  );
}

/**
 * The row's intel + exposure line. Privacy split is by PROVENANCE, not by
 * look (Codex 15): a market-quoted implied move and the company's own
 * reporting record are public; the desk's own uploaded bogey sheet and its
 * portfolio exposure are not. Top-level component — never nested inside
 * another component's body (the remount trap).
 */
export function RowIntelLine({ row }: { row: CockpitRowWire }) {
  const intel = row.intel;
  if (!intel) return null;
  // "sheet" means the implied move came from the desk's own uploaded bogey
  // sheet — a curated number, not a market quote — so it masks with the rest
  // of the desk's figures. A straddle or IV approximation is the options
  // market talking about a listed company: public, and useless when masked.
  const impliedIsDeskOwn = intel.impliedMethod === "sheet";
  const implied =
    intel.impliedMovePct === null ? null : `±${formatPercent(intel.impliedMovePct, 1)} implied`;
  return (
    <span className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-ink-faint">
      {implied !== null &&
        (impliedIsDeskOwn ? <PrivateText>{implied}</PrivateText> : <span>{implied}</span>)}
      {intel.histQuarterCount > 0 && (
        <span>
          {intel.histAvgAbsMovePct === null ? "" : `avg ±${formatPercent(intel.histAvgAbsMovePct, 1)} · `}
          beat {intel.histBeatCount}/{intel.histQuarterCount}
        </span>
      )}
      {row.netExposure !== 0 && (
        <span>
          net <Money value={row.netExposure} />
        </span>
      )}
    </span>
  );
}

/**
 * Runtime totality check (belt-and-suspenders alongside the `Record<...>`
 * exhaustiveness above): every member the contract can put in each stage
 * field, pinned `satisfies` against F's own display unions so the test file
 * can iterate them without hand-duplicating the list.
 */
export const ALL_PREVIEW_STATES = [
  "sent", "sent-by-cloud", "in-flight", "skipped", "pending", "missed", "delivery-unknown",
] as const satisfies readonly PreviewStageDisplay[];
export const ALL_RECAP_STATES = [
  "sent", "sent-by-cloud", "in-flight", "skipped", "waiting", "blocked", "delivery-unknown",
] as const satisfies readonly RecapStageDisplay[];
export const ALL_SEND_STATES = [
  "sent", "sent-by-cloud", "in-flight", "delivery-unknown",
] as const satisfies readonly EmailSendStateDisplay[];
export const ALL_ACTUAL_STATES = [
  "pending", "captured", "implausible", "blocked",
] as const satisfies readonly ActualStageState[];
