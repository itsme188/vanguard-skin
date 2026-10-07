"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GivingYear, GivingDonation } from "@/lib/queries/giving-view";
import { SymbolLink } from "../SymbolLink";
import { Chip, type ChipTone } from "../Chip";
import { ConfirmDialog } from "../ConfirmDialog";
import { Count, Money, Shares } from "@/lib/privacy/components";
import apiFetch from "@/lib/http/apiFetch";
import { todayET } from "@/lib/calendar/date-utils";
import { LotAssignmentDrawer } from "./LotAssignmentDrawer";
import { LedgerRecomputeDialog, useLedgerRecomputeFlow } from "./LedgerRecomputeDialog";
import { withLedgerAck } from "./ledger-recompute-flow";
import { ScrollFade } from "../ScrollFade";
import { LotBasisControl } from "./LotBasisControl";

/**
 * One year's giving ledger (Task 13) — stock donations table + a visually
 * separated cash-gifts sub-block. Client component: it's the mutation
 * island for Unlink, Mark reversed, Assign/Edit lots (opens
 * LotAssignmentDrawer), and inline symbol resolution — GivingView (server)
 * stays a pure read.
 *
 * Status chip tones are a carried controller ruling: unsupported→neutral,
 * reversed→down, completed→up, received→info, pending-lots→warn.
 *
 * Owner rulings 2026-10-06:
 *  - Unlink, Mark reversed and Resolve each end in a recompute of the ENTIRE
 *    tax-lot ledger, so each goes through LedgerRecomputeDialog (told first,
 *    asked, progress, result).
 *  - A row whose donated lot has an implausible basis (decided once in
 *    lib/queries/giving-view.ts) carries a "basis implausible, verify" chip,
 *    and the year header says how many such rows were left out of "Gain
 *    avoided".
 *
 * Owner request 2026-10-07: each flagged lot (`gd.flaggedLots`) is drawn by
 * LotBasisControl, which can mark its basis verified against a source or undo
 * that. A row whose flagged lots are all verified is counted again, so the
 * header's left-out line drops and disappears at zero. Those two actions are
 * NOT ledger mutations and do not go through LedgerRecomputeDialog.
 */

// Matches the backend's own strict format check in
// app/api/donations/[id]/reverse/route.ts — kept identical so the client
// never sends a shape the server would 400 on.
const REVERSED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_TONE: Record<GivingDonation["status"], ChipTone> = {
  reversed: "down",
  unsupported: "neutral",
  "pending-lots": "warn",
  completed: "up",
  received: "info",
};

const STATUS_LABEL: Record<GivingDonation["status"], string> = {
  reversed: "Reversed",
  unsupported: "Unsupported",
  "pending-lots": "Pending lots",
  completed: "Completed",
  received: "Received",
};

/**
 * Names ONE donation in a confirm: a year often holds several gifts of the
 * same symbol, and on a phone the row's own cells scroll away before the
 * action buttons come into view. Date and symbol only; the figures are drawn
 * beside it through the privacy components (DonationIdentityLine).
 */
export function donationConfirmName(gd: Pick<GivingDonation, "donation">): string {
  const d = gd.donation;
  if (d.kind === "cash") return `the cash gift received ${d.received_date}`;
  return `the ${d.symbol_raw ?? "stock"} donation received ${d.received_date}`;
}

/** The rest of the row's identity under a confirm's message. */
export function DonationIdentityLine({ gd }: { gd: GivingDonation }) {
  const d = gd.donation;
  return (
    <p className="text-xs text-ink-dim mt-2">
      {gd.accountName ? <>{gd.accountName} · </> : null}
      {d.kind === "stock" && (
        <>
          Qty <Shares value={d.quantity} digits={4} className="font-mono" /> ·{" "}
        </>
      )}
      FMV <Money value={d.fmv_usd} className="font-mono" />
    </p>
  );
}

export function GivingYearSection({ year }: { year: GivingYear }) {
  const router = useRouter();
  const flow = useLedgerRecomputeFlow();
  const [drawerDonation, setDrawerDonation] = useState<GivingDonation | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<GivingDonation | null>(null);
  const [reverseTarget, setReverseTarget] = useState<GivingDonation | null>(null);
  const [reverseDate, setReverseDate] = useState("");

  const stockDonations = year.donations.filter((gd) => gd.donation.kind === "stock");
  const cashDonations = year.donations.filter((gd) => gd.donation.kind === "cash");

  function openReverseDialog(gd: GivingDonation) {
    setReverseTarget(gd);
    setReverseDate(todayET());
  }

  // Both hand over to the recompute dialog: this first dialog says what the
  // action does to the donation, the next one says what it does to the ledger.
  function markReversed(donationId: number, reversedDate: string) {
    if (flow.active) return;
    setReverseTarget(null);
    flow.start({
      title: "Marking this donation reversed",
      send: (acknowledged) =>
        apiFetch(`/api/donations/${donationId}/reverse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLedgerAck({ reversedDate }, acknowledged)),
        }),
      onClosed: (saved) => {
        if (saved) router.refresh();
      },
    });
  }

  function unlink(donationId: number) {
    if (flow.active) return;
    setUnlinkTarget(null);
    flow.start({
      title: "Unlinking this donation",
      send: (acknowledged) =>
        apiFetch(`/api/donations/${donationId}/links`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLedgerAck({}, acknowledged)),
        }),
      onClosed: (saved) => {
        if (saved) router.refresh();
      },
    });
  }

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev space-y-4">
      <LedgerRecomputeDialog flow={flow} />
      <ConfirmDialog
        open={unlinkTarget !== null}
        title="Unlink donation"
        message={
          unlinkTarget
            ? `Unlink the OUT leg of ${donationConfirmName(unlinkTarget)}? The transfer transaction returns to the unmatched pool and any lot assignments are dropped. This recomputes the entire tax-lot ledger; you will be asked to confirm that next.`
            : ""
        }
        confirmLabel="Unlink"
        confirmDisabled={flow.active}
        variant="danger"
        onConfirm={() => unlinkTarget && unlink(unlinkTarget.donation.id)}
        onCancel={() => setUnlinkTarget(null)}
      >
        {unlinkTarget && <DonationIdentityLine gd={unlinkTarget} />}
      </ConfirmDialog>

      <ConfirmDialog
        open={reverseTarget !== null}
        title="Mark donation reversed"
        message={
          reverseTarget
            ? `Mark ${donationConfirmName(reverseTarget)} as reversed? This drops any leg links and lot assignments and stamps the reversed date below. It recomputes the entire tax-lot ledger; you will be asked to confirm that next.`
            : ""
        }
        confirmLabel="Mark reversed"
        variant="danger"
        confirmDisabled={flow.active || !REVERSED_DATE_RE.test(reverseDate)}
        onConfirm={() => reverseTarget && REVERSED_DATE_RE.test(reverseDate) && markReversed(reverseTarget.donation.id, reverseDate)}
        onCancel={() => setReverseTarget(null)}
      >
        {reverseTarget && <DonationIdentityLine gd={reverseTarget} />}
        <label htmlFor="giving-reverse-date" className="block text-xs font-medium text-ink-faint mb-1.5 mt-3">
          Reversed date
        </label>
        <input
          id="giving-reverse-date"
          type="date"
          value={reverseDate}
          onChange={(e) => setReverseDate(e.target.value)}
          required
          className="w-full rounded-lg bg-raised border border-edge px-3 py-2 text-sm text-ink font-mono"
        />
      </ConfirmDialog>

      {drawerDonation && (
        <LotAssignmentDrawer
          donationId={drawerDonation.donation.id}
          symbol={drawerDonation.donation.symbol_raw ?? "security"}
          receivedDate={drawerDonation.donation.received_date}
          targetQuantity={drawerDonation.donation.quantity}
          onClose={() => setDrawerDonation(null)}
        />
      )}

      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-medium text-ink">{year.year}</h3>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <span className="text-ink-dim">
            Total given <Money value={year.totalGiven} className="font-mono font-medium text-ink" />
          </span>
          <span className="text-ink-dim">
            Gain avoided{" "}
            {year.gainAvoided == null ? (
              <span className="text-ink-faint italic">pending lot assignment</span>
            ) : year.gainAvoidedRowsLeftOut > 0 && year.gainAvoidedRowsCounted === 0 ? (
              // Every row was left out: there is no believable total to print.
              <span className="text-ink-faint italic">not shown</span>
            ) : (
              <Money value={year.gainAvoided} className="font-mono font-medium text-up" />
            )}
            {year.gainAvoidedRowsLeftOut > 0 && (
              <span className="text-warn">
                {" "}
                · rows left out for an implausible basis:{" "}
                <Count value={year.gainAvoidedRowsLeftOut} className="font-mono font-medium" />
              </span>
            )}
          </span>
        </div>
      </header>

      {stockDonations.length > 0 && (
        <div className="rounded-lg border border-edge overflow-hidden">
          <ScrollFade>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-edge bg-raised/40">
                <th className="text-left px-3 py-2 text-ink-faint font-medium text-xs">Symbol</th>
                <th className="text-left px-3 py-2 text-ink-faint font-medium text-xs">Received</th>
                <th className="text-right px-3 py-2 text-ink-faint font-medium text-xs">Qty</th>
                <th className="text-right px-3 py-2 text-ink-faint font-medium text-xs">FMV</th>
                <th className="text-right px-3 py-2 text-ink-faint font-medium text-xs hidden md:table-cell">
                  Basis
                </th>
                <th className="text-right px-3 py-2 text-ink-faint font-medium text-xs hidden md:table-cell">
                  Gain avoided
                </th>
                <th className="text-left px-3 py-2 text-ink-faint font-medium text-xs hidden md:table-cell">
                  LT / ST
                </th>
                <th className="text-left px-3 py-2 text-ink-faint font-medium text-xs">Status</th>
                <th className="text-right px-3 py-2 text-ink-faint font-medium text-xs">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stockDonations.map((gd) => {
                const d = gd.donation;
                const struck = d.reversed_date != null;
                return (
                  <tr key={d.id} className={`border-b border-edge last:border-0 ${struck ? "opacity-60" : ""}`}>
                    <td className="px-3 py-2.5">
                      {gd.symbolResolved && d.security_id != null ? (
                        <span className={`font-mono ${struck ? "line-through text-ink-faint" : "text-ink"}`}>
                          <SymbolLink securityId={d.security_id} symbol={d.symbol_raw ?? "?"} />
                        </span>
                      ) : (
                        <ResolveSecurityControl
                          donationId={d.id}
                          rawSymbol={d.symbol_raw ?? "—"}
                          onResolved={() => router.refresh()}
                        />
                      )}
                      <span className="block text-xs text-ink-faint">{gd.accountName ?? "—"}</span>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-dim">{d.received_date}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-dim">
                      <Shares value={d.quantity} digits={4} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">
                      <Money value={d.fmv_usd} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-dim hidden md:table-cell">
                      <Money value={gd.basis} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-dim hidden md:table-cell">
                      <Money value={gd.gainAvoided} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-faint hidden md:table-cell">
                      {gd.longTermQuantity != null && gd.shortTermQuantity != null ? (
                        <>
                          LT <Shares value={gd.longTermQuantity} digits={2} className="text-ink-dim" /> / ST{" "}
                          <Shares value={gd.shortTermQuantity} digits={2} className="text-ink-dim" />
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Chip tone={STATUS_TONE[gd.status]}>{STATUS_LABEL[gd.status]}</Chip>
                      {/* One chip and one control per lot whose basis trips the
                          1% rule; the state of each is decided on the server. */}
                      {!struck &&
                        gd.flaggedLots.map((lot) => (
                          <LotBasisControl
                            key={lot.acquisitionTransactionId}
                            lot={lot}
                            symbol={d.symbol_raw ?? "this security"}
                          />
                        ))}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      {!struck && (
                        <div className="flex items-center justify-end gap-3">
                          {gd.linked && gd.symbolResolved && gd.status !== "unsupported" && (
                            <button
                              type="button"
                              onClick={() => setDrawerDonation(gd)}
                              className="text-xs text-gold hover:underline focus-ring"
                            >
                              {gd.basis != null ? "Edit lots" : "Assign lots"}
                            </button>
                          )}
                          {gd.linked && (
                            <button
                              type="button"
                              onClick={() => setUnlinkTarget(gd)}
                              className="text-xs text-ink-faint hover:text-down transition-colors focus-ring"
                            >
                              Unlink
                            </button>
                          )}
                          {/* Quiet secondary action (not a primary button) — the only
                              trigger for POST /reverse, which otherwise has no UI caller. */}
                          <button
                            type="button"
                            onClick={() => openReverseDialog(gd)}
                            className="text-xs text-ink-faint hover:text-ink transition-colors focus-ring"
                          >
                            Mark reversed…
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </ScrollFade>
        </div>
      )}

      {cashDonations.length > 0 && (
        <div className="rounded-lg border border-dashed border-edge bg-raised/30 p-3 sm:p-4">
          <p className="text-[11px] uppercase tracking-wide text-ink-faint mb-2">
            Cash gifts — bank→DAF, not portfolio activity
          </p>
          <ul className="space-y-1.5">
            {cashDonations.map((gd) => {
              const d = gd.donation;
              const struck = d.reversed_date != null;
              return (
                <li
                  key={d.id}
                  className={`flex flex-wrap items-center justify-between gap-2 text-sm ${
                    struck ? "line-through text-ink-faint" : "text-ink-dim"
                  }`}
                >
                  <span>
                    {d.received_date}
                    {d.notes ? ` · ${d.notes}` : ""}
                  </span>
                  <span className="flex items-center gap-2">
                    <Money value={d.fmv_usd} className="font-mono text-ink" />
                    <Chip tone={STATUS_TONE[gd.status]}>{STATUS_LABEL[gd.status]}</Chip>
                    {!struck && (
                      <button
                        type="button"
                        onClick={() => openReverseDialog(gd)}
                        className="text-xs text-ink-faint hover:text-ink transition-colors focus-ring"
                      >
                        Mark reversed…
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

interface SecuritySearchResult {
  id: number;
  title: string;
  subtitle: string;
}

/** Inline "Resolve…" control for donations whose import-time symbol_raw
 *  didn't match a known security (donations.security_id IS NULL). Searches
 *  GET /api/search?type=security, then POSTs resolve-security on pick. */
function ResolveSecurityControl({
  donationId,
  rawSymbol,
  onResolved,
}: {
  donationId: number;
  rawSymbol: string;
  onResolved: () => void;
}) {
  const flow = useLedgerRecomputeFlow();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(rawSymbol === "—" ? "" : rawSymbol);
  const [results, setResults] = useState<SecuritySearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(trimmed)}&type=security`);
        const json = await res.json();
        if (!cancelled) setResults(Array.isArray(json.results) ? json.results : []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  function resolve(securityId: number) {
    if (flow.active) return;
    flow.start({
      title: "Resolving this symbol",
      send: (acknowledged) =>
        apiFetch(`/api/donations/${donationId}/resolve-security`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(withLedgerAck({ securityId }, acknowledged)),
        }),
      // Refresh only once the result is closed: the refresh replaces this
      // control with the resolved symbol, which would take the dialog with it.
      onClosed: (saved) => {
        if (!saved) return;
        setOpen(false);
        onResolved();
      },
    });
  }

  if (!open) {
    return (
      <div className="flex items-center gap-1.5 font-mono">
        <span className="text-ink-dim">{rawSymbol}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-sans text-xs text-gold hover:underline focus-ring"
        >
          Resolve…
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-[220px]">
      <LedgerRecomputeDialog flow={flow} />
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search security…"
        className="w-full rounded-md bg-raised border border-edge px-2 py-1 text-xs text-ink font-mono"
      />
      <div className="mt-1 max-h-36 overflow-y-auto rounded-md border border-edge bg-panel">
        {searching && <p className="px-2 py-1 text-xs text-ink-faint">Searching…</p>}
        {!searching && results.length === 0 && query.trim().length > 0 && (
          <p className="px-2 py-1 text-xs text-ink-faint">No matches</p>
        )}
        {results.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => resolve(r.id)}
            disabled={flow.active}
            className="block w-full text-left px-2 py-1 text-xs hover:bg-raised transition-colors disabled:opacity-50 focus-ring"
          >
            <span className="font-mono text-ink">{r.title}</span> <span className="text-ink-faint">{r.subtitle}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-1 text-xs text-ink-faint hover:text-ink focus-ring"
      >
        Cancel
      </button>
    </div>
  );
}
