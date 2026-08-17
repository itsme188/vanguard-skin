"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GivingYear, GivingDonation } from "@/lib/queries/giving-view";
import { SymbolLink } from "../SymbolLink";
import { Chip, type ChipTone } from "../Chip";
import { ConfirmDialog } from "../ConfirmDialog";
import { Money, Shares } from "@/lib/privacy/components";
import { useToast } from "../Toast";
import apiFetch from "@/lib/http/apiFetch";
import { LotAssignmentDrawer } from "./LotAssignmentDrawer";

/**
 * One year's giving ledger (Task 13) — stock donations table + a visually
 * separated cash-gifts sub-block. Client component: it's the mutation
 * island for Unlink, Assign/Edit lots (opens LotAssignmentDrawer), and
 * inline symbol resolution — GivingView (server) stays a pure read.
 *
 * Status chip tones are a carried controller ruling: unsupported→neutral,
 * reversed→down, completed→up, received→info, pending-lots→warn.
 */

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

export function GivingYearSection({ year }: { year: GivingYear }) {
  const router = useRouter();
  const { toast } = useToast();
  const [drawerDonation, setDrawerDonation] = useState<GivingDonation | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<GivingDonation | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  const stockDonations = year.donations.filter((gd) => gd.donation.kind === "stock");
  const cashDonations = year.donations.filter((gd) => gd.donation.kind === "cash");

  async function unlink(donationId: number) {
    setUnlinking(true);
    try {
      const res = await apiFetch(`/api/donations/${donationId}/links`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to unlink: ${json.error ?? "unknown error"}`, "error");
        return;
      }
      if (json.data?.recomputed === false) {
        toast(
          `Saved — lot recompute failed: ${json.data.recomputeError ?? "unknown error"}. Retry from the drawer.`,
          "error"
        );
      } else {
        toast("Donation unlinked", "success");
      }
      setUnlinkTarget(null);
      router.refresh();
    } catch (err) {
      toast(`Failed to unlink: ${err instanceof Error ? err.message : "network error"}`, "error");
    } finally {
      setUnlinking(false);
    }
  }

  return (
    <section className="rounded-xl bg-panel p-4 sm:p-5 card-elev space-y-4">
      <ConfirmDialog
        open={unlinkTarget !== null}
        title="Unlink donation"
        message={
          unlinkTarget
            ? `Unlink ${unlinkTarget.donation.symbol_raw ?? "this donation"}'s OUT leg? The transfer transaction returns to the unmatched pool and any lot assignments are dropped.`
            : ""
        }
        confirmLabel={unlinking ? "Unlinking…" : "Unlink"}
        variant="danger"
        onConfirm={() => unlinkTarget && unlink(unlinkTarget.donation.id)}
        onCancel={() => setUnlinkTarget(null)}
      />

      {drawerDonation && (
        <LotAssignmentDrawer
          donationId={drawerDonation.donation.id}
          symbol={drawerDonation.donation.symbol_raw ?? "security"}
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
            {year.gainAvoided != null ? (
              <Money value={year.gainAvoided} className="font-mono font-medium text-up" />
            ) : (
              <span className="text-ink-faint italic">pending lot assignment</span>
            )}
          </span>
        </div>
      </header>

      {stockDonations.length > 0 && (
        <div className="rounded-lg border border-edge overflow-hidden overflow-x-auto">
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
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(rawSymbol === "—" ? "" : rawSymbol);
  const [results, setResults] = useState<SecuritySearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [submittingId, setSubmittingId] = useState<number | null>(null);

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

  async function resolve(securityId: number) {
    setSubmittingId(securityId);
    try {
      const res = await apiFetch(`/api/donations/${donationId}/resolve-security`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ securityId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast(`Failed to resolve symbol: ${json.error ?? "unknown error"}`, "error");
        return;
      }
      if (json.data?.recomputed === false) {
        toast(
          `Saved — lot recompute failed: ${json.data.recomputeError ?? "unknown error"}. Retry from the drawer.`,
          "error"
        );
      } else {
        toast("Symbol resolved", "success");
      }
      setOpen(false);
      onResolved();
    } catch (err) {
      toast(`Failed to resolve symbol: ${err instanceof Error ? err.message : "network error"}`, "error");
    } finally {
      setSubmittingId(null);
    }
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
            disabled={submittingId !== null}
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
