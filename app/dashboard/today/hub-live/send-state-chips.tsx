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

/**
 * What each three-letter stage chip means, spelled out for its tooltip and its
 * accessible name: the strip is "pre / act / rxn / rec" with no legend. One
 * sentence per stage and state; a state nobody has mapped yet falls back to
 * the stage name plus the raw word, so a chip is never left unexplained.
 */
const STAGE_NAMES = {
  preview: "Preview email",
  actual: "Reported figures",
  reaction: "Price reaction",
  recap: "Recap email",
} as const;

const STAGE_STATE_WORDS: Record<keyof typeof STAGE_NAMES, Record<string, string>> = {
  preview: {
    sent: "sent",
    "sent-by-cloud": "sent by the cloud fallback",
    "in-flight": "sending now",
    "delivery-unknown": "delivery unknown",
    skipped: "skipped",
    pending: "not sent yet",
    missed: "not sent before the release",
  },
  actual: {
    pending: "not captured yet",
    captured: "captured",
    implausible: "captured, but flagged as implausible against consensus",
    blocked: "still missing after the release; click to enter them",
  },
  reaction: {
    pending: "not captured yet",
    captured: "captured",
  },
  recap: {
    sent: "sent",
    "sent-by-cloud": "sent by the cloud fallback",
    "in-flight": "sending now",
    "delivery-unknown": "delivery unknown",
    skipped: "skipped",
    waiting: "waiting for the reported figures",
    blocked: "blocked; the reported figures are missing",
  },
};

export function stageTitle(stage: keyof typeof STAGE_NAMES, state: string): string {
  return `${STAGE_NAMES[stage]}: ${STAGE_STATE_WORDS[stage][state] ?? state}`;
}

export function stageChips(
  row: CockpitRowWire,
  /** Shown on the upcoming chip instead of the stored clock time — see
   * EarningsRowChips' `timeEstimateLabel`. */
  timeEstimateLabel: string | null = null,
  /** Non-null when the row's actual was saved before its print window opened
   * (owner ruling 2026-10-06, display-only). The SERVER row decides it with
   * isPreReleaseActual and passes PRE_RELEASE_ACTUAL_TITLE as the tooltip —
   * this client file may not value-import @/lib/calendar
   * (tests/repo/hub-live-client-boundary.test.ts). A captured actual then
   * reads "act pre-release" in the warn tone instead of the green "act ✓";
   * every other state is unchanged. */
  preReleaseActualTitle: string | null = null,
): Array<{ key: string; tone: ChipTone; text: string; title: string; clickable: "preview" | "recap" | "actuals" | null }> {
  const released = row.stages.released;
  const releasedChip =
    released.state === "released"
      ? { tone: "gold" as ChipTone, text: "released", title: "Released: the print window has opened" }
      : released.state === "upcoming"
        ? {
            tone: "neutral" as ChipTone,
            text: timeEstimateLabel ?? row.releaseTime ?? row.eventTime ?? "—",
            title: timeEstimateLabel
              ? "Release time: an estimate, not a confirmed time"
              : "Release time (ET): not released yet",
          }
        : { tone: "neutral" as ChipTone, text: row.eventTime ?? "time?", title: "Release time: not known" };
  const reaction =
    row.stages.reaction.state === "captured"
      ? { tone: "up" as ChipTone, text: `rxn ✓${row.stages.reaction.source ? ` ${row.stages.reaction.source}` : ""}` }
      : { tone: "neutral" as ChipTone, text: "rxn" };
  const reactionTitle =
    stageTitle("reaction", row.stages.reaction.state) +
    (row.stages.reaction.state === "captured" && row.stages.reaction.source
      ? ` (source: ${row.stages.reaction.source})`
      : "");

  // A chip that already explains itself (delivery unknown, pre-release) keeps
  // its own sentence; every other chip gets the stage-and-state one.
  const titled = <T extends { title?: string }>(chip: T, fallback: string): T & { title: string } => ({
    ...chip,
    title: chip.title ?? fallback,
  });

  const actualChip =
    preReleaseActualTitle !== null && row.stages.actual === "captured"
      ? { tone: "warn" as ChipTone, text: "act pre-release", title: preReleaseActualTitle }
      : chipFor("act", row.stages.actual);

  return [
    { key: "released", ...releasedChip, clickable: null },
    {
      key: "preview",
      ...titled(
        withFullWord(chipFor("pre", row.stages.preview), row.stages.preview),
        stageTitle("preview", row.stages.preview),
      ),
      clickable: VIEWABLE.has(row.stages.preview) ? "preview" : null,
    },
    {
      key: "actual",
      ...titled(actualChip, stageTitle("actual", row.stages.actual)),
      clickable: row.stages.actual === "blocked" ? "actuals" : null,
    },
    { key: "reaction", ...reaction, title: reactionTitle, clickable: null },
    {
      key: "recap",
      ...titled(
        withFullWord(chipFor("rec", row.stages.recap), row.stages.recap),
        stageTitle("recap", row.stages.recap),
      ),
      clickable: VIEWABLE.has(row.stages.recap) ? "recap" : null,
    },
  ];
}

export function StageChipStrip({
  row,
  onOpen,
  timeEstimateLabel = null,
  preReleaseActualTitle = null,
}: {
  row: CockpitRowWire;
  onOpen: (what: "preview" | "recap" | "actuals") => void;
  timeEstimateLabel?: string | null;
  preReleaseActualTitle?: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {stageChips(row, timeEstimateLabel, preReleaseActualTitle).map((c) =>
        c.clickable ? (
          <button
            key={c.key}
            type="button"
            title={c.title}
            aria-label={c.title}
            onClick={() => onOpen(c.clickable!)}
            className="relative active:scale-[0.96] transition-transform after:absolute after:content-[''] after:-inset-y-2 after:-inset-x-0.5"
          >
            <Chip tone={c.tone} size="xs" className="cursor-pointer">{c.text}</Chip>
          </button>
        ) : (
          // role="img": the abbreviation is read as its full sentence.
          <span key={c.key} role="img" aria-label={c.title} className="inline-flex">
            <Chip tone={c.tone} size="xs" title={c.title}>{c.text}</Chip>
          </span>
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
