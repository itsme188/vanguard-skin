"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { GivingFlaggedLot, GivingLotGift } from "@/lib/queries/giving-view";
import { Chip, type ChipTone } from "../Chip";
import { Count, PrivateText } from "@/lib/privacy/components";
import { usePrivacy } from "@/lib/privacy/context";
import apiFetch from "@/lib/http/apiFetch";
import {
  LOT_BASIS_CHIP_LABEL,
  SOURCE_NOTE_MAX_LENGTH,
  createBusyGuard,
  sendMarkBasisVerified,
  sendUnmarkBasisVerified,
  sourceNoteProblem,
  verificationSummary,
} from "./lot-basis-actions";

/**
 * One flagged donated lot on a Giving row (owner request 2026-10-07): its
 * chip, and the control to mark its basis verified or undo that.
 *
 * A lot is listed here only when its basis trips the 1% rule. Its state is
 * decided once on the server (`donatedLotBasisState`, lib/queries/giving-view.ts):
 *  - implausible: warn chip, "Mark basis verified".
 *  - verified: quiet chip with the source and date, "Undo".
 *  - verified-stale: warn chip, the old source, "Mark basis verified".
 * The server refuses a mark while the tax-lot ledger is waiting on a
 * recompute; its plain reason is shown in the form like any other refusal.
 *
 * A marker belongs to the LOT, and one lot can feed several gifts, so one
 * save changes every row the lot is flagged on. The form says so and lists
 * those gifts by year (`lot.giftsFed`, built by the same server read).
 *
 * These two actions are the only Giving writes that do NOT go through
 * LedgerRecomputeDialog: a marker changes no tax figure and nothing is
 * recomputed, so there is nothing to disclose or confirm.
 */

const CHIP_TONE: Record<GivingFlaggedLot["state"], ChipTone> = {
  implausible: "warn",
  verified: "neutral",
  "verified-stale": "warn",
};

/**
 * A 32px-tall tap target for the small text actions, without making the row
 * taller: the button grows to 32px and the negative margin gives the extra
 * height back to the layout, so only the area that takes a tap changes.
 */
const ROW_ACTION_HIT_AREA = "inline-flex items-center min-h-8 -my-2";

export interface LotBasisNotice {
  tone: "error" | "info";
  text: string;
}

/** The chip, the lines under it and the buttons. Holds no state of its own. */
export function LotBasisStatus({
  lot,
  busy,
  notice,
  onMark,
  onUndo,
}: {
  lot: GivingFlaggedLot;
  busy: boolean;
  notice: LotBasisNotice | null;
  onMark: () => void;
  onUndo: () => void;
}) {
  const { isPrivate } = usePrivacy();
  const summary = verificationSummary(lot);
  // A tooltip cannot be masked, so privacy mode shows none.
  const title = summary != null && !isPrivate ? summary : undefined;

  return (
    <div className="mt-1.5 flex flex-col items-start gap-1 whitespace-normal">
      <Chip tone={CHIP_TONE[lot.state]} title={title}>
        {LOT_BASIS_CHIP_LABEL[lot.state]}
      </Chip>
      <span className="text-xs text-ink-dim">Lot acquired {lot.acquisitionDate}</span>
      {summary != null && (
        <span className="text-xs text-ink-dim">
          <PrivateText>{summary}</PrivateText>
        </span>
      )}
      {lot.state === "verified-stale" && (
        <span className="text-xs text-warn">
          The lot&apos;s basis or share count has changed since then, so this gift is left out again.
        </span>
      )}
      {lot.state === "verified" ? (
        <button
          type="button"
          onClick={onUndo}
          disabled={busy}
          aria-label={`Undo basis verified for the lot acquired ${lot.acquisitionDate}`}
          className={`${ROW_ACTION_HIT_AREA} text-xs text-ink-dim underline hover:text-ink transition-colors focus-ring disabled:opacity-50`}
        >
          {busy ? "Undoing…" : "Undo"}
        </button>
      ) : (
        <button
          type="button"
          onClick={onMark}
          disabled={busy}
          className={`${ROW_ACTION_HIT_AREA} text-xs text-gold-ink hover:underline focus-ring disabled:opacity-50`}
        >
          Mark basis verified
        </button>
      )}
      {notice && (
        <span
          role={notice.tone === "error" ? "alert" : "status"}
          className={`text-xs ${notice.tone === "error" ? "text-down" : "text-ink-dim"}`}
        >
          {notice.text}
        </span>
      )}
    </div>
  );
}

/** How many of the gifts a lot feeds fall in each year, oldest year first. */
export function giftsFedByYear(gifts: GivingLotGift[]): { year: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const gift of gifts) {
    const year = gift.receivedDate.slice(0, 4);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([year, count]) => ({ year, count }));
}

/**
 * What one save reaches. With one gift the plain sentence is enough. With
 * several, the form says the check is per lot and lists the gifts by year.
 * A count is a portfolio figure, so each goes through <Count>; in privacy
 * mode the noun stays plural so it cannot give away a single gift.
 */
export function GiftsFedNote({ gifts }: { gifts: GivingLotGift[] }) {
  const { isPrivate } = usePrivacy();
  if (gifts.length <= 1) {
    return <> The gift then counts toward Gain avoided again.</>;
  }
  return (
    <>
      <span className="block mt-2">
        This check is saved for the lot, not for one gift. This lot feeds <Count value={gifts.length} /> gifts, and
        saving changes all of them:
      </span>
      <ul className="mt-1 list-disc pl-5">
        {giftsFedByYear(gifts).map(({ year, count }) => (
          <li key={year}>
            {year}: <Count value={count} /> {count === 1 && !isPrivate ? "gift" : "gifts"}
          </li>
        ))}
      </ul>
      <span className="block mt-1">
        Each of them counts toward Gain avoided again, unless another of its lots is still flagged.
      </span>
    </>
  );
}

/** The one-field form: what was the basis checked against? */
export function BasisVerifiedDialog({
  open,
  symbol,
  acquisitionDate,
  giftsFed,
  note,
  busy,
  error,
  onNoteChange,
  onSave,
  onCancel,
}: {
  open: boolean;
  symbol: string;
  acquisitionDate: string;
  /** The gifts this lot is flagged on (`GivingFlaggedLot.giftsFed`). */
  giftsFed: GivingLotGift[];
  note: string;
  busy: boolean;
  error: string | null;
  onNoteChange: (note: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  // Save stays disabled with nothing to save; the hint says why.
  const noteEmpty = note.trim().length === 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Escape goes through onCancel, which ignores it while a save is out.
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSave();
  }

  return (
    <dialog
      ref={dialogRef}
      // m-auto restores the dialog centering that Tailwind's margin reset removes.
      className="m-auto rounded-xl border border-edge bg-panel p-0 text-left text-ink backdrop:bg-canvas/70 backdrop:backdrop-blur-sm max-w-sm w-full whitespace-normal"
    >
      <form onSubmit={handleSubmit}>
        <div className="p-6">
          <h3 className="text-base font-medium mb-2 whitespace-nowrap!">Mark basis verified</h3>
          <div className="text-sm text-ink-dim">
            Use this when you have checked the basis of the {symbol} lot acquired {acquisitionDate} against a
            document and the small figure is right.
            <GiftsFedNote gifts={giftsFed} />
          </div>
          <p className="text-sm text-ink-dim mt-2">
            This only records your check. It changes no tax figure and does not recompute the ledger.
          </p>
          <label htmlFor={inputId} className="block text-xs font-medium text-ink-dim mb-1.5 mt-3">
            Source (for example: final K-1, 2020)
          </label>
          <input
            id={inputId}
            ref={inputRef}
            type="text"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            required
            maxLength={SOURCE_NOTE_MAX_LENGTH}
            autoComplete="off"
            placeholder="final K-1, 2020"
            aria-describedby={noteEmpty ? hintId : undefined}
            className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink"
          />
          {noteEmpty && (
            <p id={hintId} className="text-xs text-ink-dim mt-1.5">
              Enter where you checked this basis, then save.
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-down mt-2">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 pb-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-edge text-sm text-ink-dim hover:text-ink hover:bg-raised transition-colors focus-ring disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || noteEmpty}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gold text-canvas hover:brightness-110 transition-[filter,scale] active:scale-[0.96] focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function LotBasisControl({ lot, symbol }: { lot: GivingFlaggedLot; symbol: string }) {
  const router = useRouter();
  const { isPrivate } = usePrivacy();
  // Outside React state on purpose: a second click in the same frame is refused.
  const [guard] = useState(() => createBusyGuard());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<LotBasisNotice | null>(null);

  function openDialog() {
    if (busy) return;
    // Verifying again starts from the source given last time. Not in privacy
    // mode: a text field cannot be masked, so it starts empty there.
    setNote(isPrivate ? "" : (lot.sourceNote ?? ""));
    setDialogError(null);
    setNotice(null);
    setDialogOpen(true);
  }

  function closeDialog() {
    if (busy) return;
    setDialogOpen(false);
  }

  async function save() {
    const problem = sourceNoteProblem(note);
    if (problem) {
      setDialogError(problem);
      return;
    }
    const pending = guard.run(() => sendMarkBasisVerified(apiFetch, lot.acquisitionTransactionId, note));
    if (!pending) return;
    setBusy(true);
    setDialogError(null);
    const result = await pending;
    setBusy(false);
    if (!result.ok) {
      // Nothing was saved: the form stays open with the reason.
      setDialogError(result.message);
      return;
    }
    setDialogOpen(false);
    router.refresh();
  }

  async function undo() {
    const pending = guard.run(() => sendUnmarkBasisVerified(apiFetch, lot.acquisitionTransactionId));
    if (!pending) return;
    setBusy(true);
    setNotice(null);
    const result = await pending;
    setBusy(false);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.message });
      return;
    }
    if (result.message) setNotice({ tone: "info", text: result.message });
    router.refresh();
  }

  return (
    <>
      <LotBasisStatus lot={lot} busy={busy} notice={notice} onMark={openDialog} onUndo={undo} />
      <BasisVerifiedDialog
        open={dialogOpen}
        symbol={symbol}
        acquisitionDate={lot.acquisitionDate}
        giftsFed={lot.giftsFed}
        note={note}
        busy={busy}
        error={dialogError}
        onNoteChange={setNote}
        onSave={save}
        onCancel={closeDialog}
      />
    </>
  );
}
