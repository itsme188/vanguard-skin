"use client";

import { Suspense, useEffect, useMemo, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { LevelAlert, AlertResponse, LevelReviewStatus } from "@/lib/types";
import { PrivateText, Shares } from "@/lib/privacy/components";
// Level prices, trigger prices, and current market prices are PUBLIC market
// data — they reveal nothing about what the user owns/earns, so they render
// via pure formatters, never privacy-masked (held quantities still mask).
import {
  formatCompactOptionSymbol,
  formatPercent,
  formatUSDPrecise,
} from "@/lib/format";
import { suggestOutcomeMessage } from "@/lib/alerts/suggest-message";
import {
  BEYOND_SCAN_RANGE_EXPLANATION,
  BEYOND_SCAN_RANGE_LABEL,
  STALE_PRICE_EXPLANATION,
  STALE_PRICE_LABEL,
  isLevelBeyondScanRange,
  scanRangeDistancePct,
} from "@/lib/levels/scan-range";
import { useToast } from "../components/Toast";
import { SortPicker } from "../components/SortPicker";
import { SymbolLink } from "../components/SymbolLink";
import { Chip } from "../components/Chip";
import { compareValues, useSortParam, type SortState } from "@/lib/hooks/useSortParam";
import { EarningsDateChip } from "../today/EarningsDateChip";
import type { EarningsDateConflict } from "@/lib/queries/calendar";
import type { SentEarningsEmail } from "@/lib/queries/earnings-emails";
import { EarningsEmailViewer } from "../components/EarningsEmailViewer";
import apiFetch from "@/lib/http/apiFetch";

// One armed level as returned by GET /api/levels/armed (mirrors ArmedLevel in
// lib/queries/security-levels.ts). Prices here are PUBLIC market data.
interface ArmedLevelView {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  price: number;
  price_source: string;
  effective_price: number | null;
  current_price: number | null;
  distance_pct: number | null;
  direction: string | null;
  action_hint: string | null;
  source: string;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  set_date: string;
  /** Server-computed via the scanner's own band — see lib/levels/scan-range.ts. */
  beyond_scan_range?: boolean;
  /** The scanner's OTHER skip condition, also server-computed: the price
   *  behind `current_price` is older than the scan freshness window, so this
   *  row is armed but NOT being monitored. Without it the row rendered a
   *  fresh-looking "Now" price and distance chip over a weeks-old close. */
  price_is_stale?: boolean;
  price_date?: string | null;
}

const LEVEL_TYPE_LABEL: Record<string, string> = {
  support: "Support",
  resistance: "Resistance",
  entry: "Entry",
  exit: "Exit",
  stop: "Stop",
  scale_in: "Scale-in",
};

type ArmedSortField = "nearest" | "symbol" | "level_price" | "source_author" | "level_type";

const ARMED_SORT_OPTIONS = [
  { field: "nearest" as const, label: "Nearest" },
  { field: "symbol" as const, label: "Symbol" },
  { field: "level_price" as const, label: "Price" },
  { field: "source_author" as const, label: "Source" },
  { field: "level_type" as const, label: "Type" },
];

type StreamSortField = "recency" | "symbol" | "level_price" | "source_author";

const SORT_OPTIONS = [
  { field: "recency" as const, label: "Recency" },
  { field: "symbol" as const, label: "Symbol" },
  { field: "level_price" as const, label: "Price" },
  { field: "source_author" as const, label: "Source" },
];

interface EnrichedAlert extends LevelAlert {
  symbol: string | null;
  security_name: string | null;
  level: {
    level_type: string;
    price: number;
    price_source: string;
    direction: string | null;
    source: string;
    source_author: string | null;
    thesis: string | null;
  } | null;
}

interface PendingLevel {
  id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  level_type: string;
  price: number;
  price_source: string;
  direction: string | null;
  action_hint: string | null;
  source_author: string | null;
  thesis: string | null;
  timeframe: string | null;
  source_article_id: number | null;
  current_price: number | null;
  /** Needed to judge the plausibility band before approving — options are
   *  exempt from it. Supplied by getPendingReviewLevels. */
  security_type?: string | null;
  created_at: string;
}

/** Why an arm was refused — mirrors ApproveLevelGuardResult['code'] in
 *  lib/alerts/approve.ts. Both are 409s the user can override with force. */
type ArmRefusalReason = "would_fire_immediately" | "beyond_scan_range";

const ARM_REFUSAL_REASONS: ArmRefusalReason[] = [
  "would_fire_immediately",
  "beyond_scan_range",
];

/** True for a 409 code that means "refused, nothing written, force overrides"
 *  — every such code must offer the confirm path, never a dead-end toast. */
function isArmRefusal(code: unknown): code is ArmRefusalReason {
  return ARM_REFUSAL_REASONS.includes(code as ArmRefusalReason);
}

// Per-level arm-refusal confirm state, keyed by level id — see decideReview's
// 409 handling. `reason` decides the copy: one says the alert fires instantly,
// the other says it can never fire at all.
type ForceConfirmMap = Record<
  number,
  { currentPrice: number; effectivePrice: number; reason: ArmRefusalReason }
>;

type StreamFilter =
  | "pending"
  | "review"
  | "armed"
  | "conflicts"
  | "emails"
  | "acted"
  | "ignored"
  | "dismissed"
  | "all";

const FILTER_OPTIONS: Array<{ label: string; value: StreamFilter }> = [
  { label: "Pending", value: "pending" },
  { label: "Review", value: "review" },
  { label: "Armed", value: "armed" },
  { label: "Conflicts", value: "conflicts" },
  { label: "Emails", value: "emails" },
  { label: "Acted", value: "acted" },
  { label: "Ignored", value: "ignored" },
  { label: "Dismissed", value: "dismissed" },
  { label: "All", value: "all" },
];

function isToday(iso: string): boolean {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return false;
  const now = new Date();
  return t.toDateString() === now.toDateString();
}

function formatPriceSourceLabel(source: string): string {
  const m = /^(sma|ema)_(\d+)$/.exec(source);
  if (!m) return source;
  return `${m[1].toUpperCase()} ${m[2]}`;
}

/** Signed distance from a level to spot, in percent. Delegates to the band
 *  helper so this page can't quote a figure derived with a different
 *  denominator than the guard that produced the warning it sits next to. */
function distancePct(level: number, current: number | null): number | null {
  return scanRangeDistancePct(level, current);
}

type StreamItem =
  | { kind: "alert"; recencyAt: string; alert: EnrichedAlert }
  | { kind: "review"; recencyAt: string; level: PendingLevel };

export default function AlertsPage() {
  // useSearchParams below would CSR-bail this entire route at build time
  // without a Suspense boundary. Wrap the inner client logic to localize.
  return (
    <Suspense fallback={<p className="text-[11px] text-ink-faint italic py-6 text-center">Loading…</p>}>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();

  // Filter is reflected in the URL so other surfaces can deep-link:
  // /dashboard/levels/review → ?view=review; the Today "armed levels" link →
  // ?view=armed. Treat those as the matching filter on first render.
  const viewParam = searchParams.get("view");
  const initialFilter: StreamFilter =
    viewParam === "review"
      ? "review"
      : viewParam === "armed"
        ? "armed"
        : viewParam === "conflicts"
          ? "conflicts"
          : viewParam === "emails"
            ? "emails"
            : "pending";

  const [filter, setFilter] = useState<StreamFilter>(initialFilter);
  const [alerts, setAlerts] = useState<EnrichedAlert[]>([]);
  const [reviewLevels, setReviewLevels] = useState<PendingLevel[]>([]);
  const [armedLevels, setArmedLevels] = useState<ArmedLevelView[]>([]);
  const [conflicts, setConflicts] = useState<EarningsDateConflict[]>([]);
  const [sentEmails, setSentEmails] = useState<SentEarningsEmail[]>([]);
  const [emailsLoaded, setEmailsLoaded] = useState(false);
  const [pendingAlertCount, setPendingAlertCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [approvingAll, setApprovingAll] = useState(false);
  // Per-row in-flight guard: a review PATCH can take minutes when the
  // background sync is starving the event loop (observed 200s live) — an
  // un-disabled Approve reads as a dead button and invites double-clicks.
  const [decidingId, setDecidingId] = useState<number | null>(null);
  // Per-level arm-refusal confirm state — populated when a 409 comes back from
  // PATCH /api/levels/review, for either reason (already past the level, or
  // outside the scanner's range). Cleared on confirm (forced retry), cancel,
  // or once the level leaves reviewLevels (approved/rejected some other way).
  const [forceConfirm, setForceConfirm] = useState<ForceConfirmMap>({});
  // "Approve all" summary confirm — set when one or more of the batch came
  // back 409 on the unforced first pass. Counted per reason so the summary can
  // say which problem it's asking about instead of guessing.
  const [approveAllConfirm, setApproveAllConfirm] = useState<{
    ids: number[];
    total: number;
    wouldFireCount: number;
    beyondRangeCount: number;
  } | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const { sort, setSort } = useSortParam<StreamSortField>("alerts", "recency", "desc");

  // When the user toggles a filter pill we drop ?view=review from the URL
  // (it was only meaningful as an entry hint).
  function selectFilter(next: StreamFilter) {
    setFilter(next);
    if (searchParams.get("view")) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("view");
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?");
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch alerts (filtered by response if the filter maps to a response
      // state) and review levels in parallel.
      const alertsResponseParam =
        filter === "pending"
          ? "pending"
          : filter === "acted" || filter === "ignored" || filter === "dismissed"
            ? filter
            : null;
      const alertsUrl = alertsResponseParam
        ? `/api/alerts?response=${alertsResponseParam}`
        : "/api/alerts";

      // Armed levels + date conflicts are fetched every refresh so their
      // pill badges stay live regardless of which filter is active (the
      // conflicts badge must agree with the NotificationBell count).
      const [alertsRes, reviewRes, armedRes, conflictsRes] = await Promise.all([
        fetch(alertsUrl),
        fetch("/api/levels/review"),
        fetch("/api/levels/armed"),
        fetch("/api/earnings/conflicts"),
      ]);
      const [alertsJson, reviewJson, armedJson, conflictsJson] = await Promise.all([
        alertsRes.json(),
        reviewRes.json(),
        armedRes.json(),
        conflictsRes.json(),
      ]);

      if (alertsJson?.success) {
        setAlerts(alertsJson.alerts as EnrichedAlert[]);
        setPendingAlertCount(alertsJson.pendingCount as number);
      }
      if (reviewJson?.success) {
        setReviewLevels(reviewJson.levels as PendingLevel[]);
      }
      if (armedJson?.success) {
        setArmedLevels(armedJson.levels as ArmedLevelView[]);
      }
      if (conflictsJson?.success) {
        setConflicts((conflictsJson.conflicts ?? []) as EarningsDateConflict[]);
      }
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Archive tab data loads lazily on first activation — sent emails don't
  // change while the page is open, so no need to refetch on every refresh
  // like the live pill badges do (spec: 2026-07-28-earnings-email-archive).
  useEffect(() => {
    if (filter !== "emails" || emailsLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/earnings/emails");
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) {
          setSentEmails((json.emails ?? []) as SentEarningsEmail[]);
          setEmailsLoaded(true);
        }
      } catch {
        // Leave emailsLoaded false — next tab activation retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, emailsLoaded]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function respond(id: number, response: AlertResponse, note?: string) {
    const res = await apiFetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, response, note }),
    });
    if (res.ok) {
      const kind: "success" | "info" = response === "acted" ? "success" : "info";
      toast(`Alert marked ${response}`, kind);
      window.dispatchEvent(new CustomEvent("alerts-updated"));
    } else {
      toast("Failed to update alert", "error");
    }
    refresh();
  }

  function clearForceConfirm(id: number) {
    setForceConfirm((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function decideReview(id: number, status: LevelReviewStatus, force = false) {
    setDecidingId(id);
    try {
      await decideReviewInner(id, status, force);
    } finally {
      setDecidingId(null);
    }
  }

  async function decideReviewInner(id: number, status: LevelReviewStatus, force = false) {
    // Which refusal the user is overriding, captured before the write so the
    // success toast can describe what they actually just armed.
    const forcedReason = force ? forceConfirm[id]?.reason : undefined;
    const res = await apiFetch("/api/levels/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, status, force }),
    });
    const data = await res.json().catch(() => null);

    if (res.ok && data?.success) {
      toast(
        status === "auto_approved"
          ? force
            ? forcedReason === "beyond_scan_range"
              ? "Level armed — it sits outside the scanner's range, so it will not alert until price moves closer"
              : "Level armed — price is already past this level, so it will fire on the next scan"
            : "Level approved — now armed"
          : "Level rejected",
        status === "auto_approved" ? "success" : "info"
      );
      // Optimistic: drop the row immediately.
      setReviewLevels((prev) => prev.filter((l) => l.id !== id));
      clearForceConfirm(id);
      window.dispatchEvent(new CustomEvent("reviews-updated"));
      await refresh();
      return;
    }

    // Both refusals arrive in the same envelope and are both force-overridable
    // — 'would_fire_immediately' (fires instantly) and 'beyond_scan_range'
    // (can never fire). Neither wrote anything.
    if (res.status === 409 && isArmRefusal(data?.code)) {
      // Refused, no write — show a per-card confirm instead of a generic
      // failure toast. The row stays in reviewLevels (still pending).
      setForceConfirm((prev) => ({
        ...prev,
        [id]: {
          currentPrice: data.currentPrice,
          effectivePrice: data.effectivePrice,
          reason: data.code as ArmRefusalReason,
        },
      }));
      return;
    }

    toast(data?.error ?? "Failed to update level", "error");
  }

  function cancelForceConfirm(id: number) {
    clearForceConfirm(id);
    toast("Left pending — level was not armed", "info");
  }

  async function approveAll() {
    if (reviewLevels.length === 0) return;
    setApprovingAll(true);
    try {
      const ids = reviewLevels.map((l) => l.id);
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await apiFetch("/api/levels/review", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status: "auto_approved" }),
          });
          const data = await res.json().catch(() => null);
          const refusedReason =
            res.status === 409 && isArmRefusal(data?.code)
              ? (data.code as ArmRefusalReason)
              : null;
          return {
            id,
            ok: res.ok && data?.success === true,
            refused: refusedReason !== null,
            refusedReason,
          };
        })
      );

      const armedIds = results.filter((r) => r.ok).map((r) => r.id);
      const refusedIds = results.filter((r) => r.refused).map((r) => r.id);
      const failedIds = results
        .filter((r) => !r.ok && !r.refused)
        .map((r) => r.id);

      if (armedIds.length > 0) {
        toast(`${armedIds.length} level${armedIds.length === 1 ? "" : "s"} approved`, "success");
        setReviewLevels((prev) => prev.filter((l) => !armedIds.includes(l.id)));
        window.dispatchEvent(new CustomEvent("reviews-updated"));
      }
      if (failedIds.length > 0) {
        toast(
          `${failedIds.length} level${failedIds.length === 1 ? "" : "s"} failed to approve — still pending`,
          "error"
        );
      }
      if (refusedIds.length > 0) {
        setApproveAllConfirm({
          ids: refusedIds,
          total: ids.length,
          wouldFireCount: results.filter(
            (r) => r.refusedReason === "would_fire_immediately"
          ).length,
          beyondRangeCount: results.filter(
            (r) => r.refusedReason === "beyond_scan_range"
          ).length,
        });
      }
      await refresh();
    } finally {
      setApprovingAll(false);
    }
  }

  async function confirmApproveAllForce() {
    if (!approveAllConfirm) return;
    const ids = approveAllConfirm.ids;
    setApprovingAll(true);
    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          const res = await apiFetch("/api/levels/review", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, status: "auto_approved", force: true }),
          });
          const data = await res.json().catch(() => null);
          return { id, ok: res.ok && data?.success === true };
        })
      );
      const armedIds = results.filter((r) => r.ok).map((r) => r.id);
      const failedIds = results.filter((r) => !r.ok).map((r) => r.id);

      if (armedIds.length > 0) {
        // Say what was actually overridden: a mixed batch gets the neutral
        // wording rather than promising an imminent alert for levels that in
        // fact can never fire.
        const onlyBeyond =
          approveAllConfirm.beyondRangeCount > 0 &&
          approveAllConfirm.wouldFireCount === 0;
        const onlyWouldFire =
          approveAllConfirm.wouldFireCount > 0 &&
          approveAllConfirm.beyondRangeCount === 0;
        const tail = onlyBeyond
          ? " — outside the scanner's range, so they will not alert until price moves closer"
          : onlyWouldFire
            ? " — already past level, will fire on the next scan"
            : " — overriding the scan warnings";
        toast(
          `${armedIds.length} level${armedIds.length === 1 ? "" : "s"} armed${tail}`,
          "success"
        );
        setReviewLevels((prev) => prev.filter((l) => !armedIds.includes(l.id)));
        window.dispatchEvent(new CustomEvent("reviews-updated"));
      }
      if (failedIds.length > 0) {
        toast(`${failedIds.length} level${failedIds.length === 1 ? "" : "s"} failed to arm`, "error");
      }
      await refresh();
    } finally {
      setApproveAllConfirm(null);
      setApprovingAll(false);
    }
  }

  function cancelApproveAllForce() {
    if (!approveAllConfirm) return;
    const n = approveAllConfirm.ids.length;
    toast(`${n} level${n === 1 ? "" : "s"} left pending — not armed`, "info");
    setApproveAllConfirm(null);
  }

  async function runDetect() {
    setDetecting(true);
    setActionStatus(null);
    try {
      const res = await apiFetch("/api/alerts/detect", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        const { scanned, fired, deduped } = json as {
          scanned: number;
          fired: number;
          deduped: number;
        };
        setActionStatus(
          fired > 0
            ? `Scan complete — ${fired} new alert${fired === 1 ? "" : "s"} fired${
                deduped > 0 ? ` (${deduped} already alerted today)` : ""
              }.`
            : scanned === 0
              ? "Scan complete. No levels have been crossed by the current price. This is normal — a level only fires an alert when the price actually reaches it (e.g., a $150 support fires when the price drops to $150). Your levels are still active and being monitored."
              : `Scan complete — ${scanned} level${scanned === 1 ? "" : "s"} already alerted today; nothing new to report.`
        );
      } else {
        setActionStatus("Scan failed — see console for details.");
      }
      await refresh();
    } finally {
      setDetecting(false);
    }
  }

  async function runSuggest(alertId?: number, opts?: { silent?: boolean }) {
    setSuggesting(true);
    if (!opts?.silent) setActionStatus(null);
    try {
      const res = await apiFetch("/api/alerts/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alertId ? { alertId } : {}),
      });
      const json = await res.json();
      // The page-load auto-fill path is fire-and-forget: no banner on success
      // OR failure — only a user-clicked Suggest all reports its outcome.
      if (opts?.silent) {
        await refresh();
        return;
      }
      if (json.success && !alertId) {
        const { generated, failed } = json as { generated?: number; failed?: number };
        if (generated !== undefined) {
          setActionStatus(suggestOutcomeMessage(generated, failed));
        }
      } else if (!json.success) {
        setActionStatus(
          `Suggestion failed: ${json.error ?? `server returned ${res.status}`}. Existing suggestions are unaffected.`
        );
      }
      await refresh();
    } finally {
      setSuggesting(false);
    }
  }

  // Auto-fill suggestions for any pending alerts that don't have one yet —
  // fire-and-forget, runs once per visit. Stays silent if the API errors.
  useEffect(() => {
    const needsSuggestion = alerts.some(
      (a) => a.user_response === "pending" && !a.suggested_action
    );
    if (needsSuggestion && !suggesting) {
      runSuggest(undefined, { silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alerts.length]);

  // Build the stream of items for the current filter.
  const streamItems = useMemo<StreamItem[]>(() => {
    // Armed + Conflicts + Emails are their own views, not alert/review streams.
    if (filter === "armed" || filter === "conflicts" || filter === "emails") return [];
    if (filter === "review") {
      return reviewLevels.map((l) => ({ kind: "review", recencyAt: l.created_at, level: l }));
    }
    if (filter === "acted" || filter === "ignored" || filter === "dismissed") {
      return alerts.map((a) => ({ kind: "alert", recencyAt: a.triggered_at, alert: a }));
    }
    // 'pending' or 'all' — merged stream
    const items: StreamItem[] = [
      ...alerts.map<StreamItem>((a) => ({ kind: "alert", recencyAt: a.triggered_at, alert: a })),
      ...reviewLevels.map<StreamItem>((l) => ({
        kind: "review",
        recencyAt: l.created_at,
        level: l,
      })),
    ];
    return items;
  }, [filter, alerts, reviewLevels]);

  const sortedItems = useMemo<StreamItem[]>(() => {
    if (!sort.field) return streamItems;
    const field = sort.field;
    const getValue = (it: StreamItem): unknown => {
      if (field === "recency") return it.recencyAt;
      if (field === "symbol") {
        return it.kind === "alert" ? it.alert.symbol : it.level.symbol;
      }
      if (field === "level_price") {
        return it.kind === "alert" ? it.alert.level?.price ?? null : it.level.price;
      }
      if (field === "source_author") {
        return it.kind === "alert"
          ? it.alert.level?.source_author ?? null
          : it.level.source_author ?? null;
      }
      return null;
    };
    return [...streamItems].sort((a, b) => compareValues(getValue(a), getValue(b), sort.dir));
  }, [streamItems, sort]);

  const reviewCount = reviewLevels.length;
  const armedCount = armedLevels.length;
  const conflictCount = conflicts.length;
  const isPending = filter === "pending";
  const isReview = filter === "review";
  const isArmed = filter === "armed";
  const isConflicts = filter === "conflicts";
  const isEmails = filter === "emails";
  const totalPending = pendingAlertCount + reviewCount;

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl text-ink font-medium">Alerts</h1>
          <p className="text-[11px] text-ink-faint mt-0.5">
            Triggered levels and newsletter-extracted suggestions in one inbox.{" "}
            <Link
              href="/dashboard/levels/performance"
              className="text-gold-ink hover:text-gold"
            >
              Source performance →
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {reviewCount > 0 && (
            <button
              onClick={approveAll}
              disabled={approvingAll}
              className="relative px-3 py-1.5 text-xs font-medium rounded-lg border border-gold/30 bg-gold/10 text-gold-ink hover:bg-gold/20 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
              title="Approve every pending newsletter level so the scanner can arm them"
            >
              Approve all ({reviewCount})
            </button>
          )}
          <button
            onClick={() => runSuggest()}
            disabled={suggesting}
            className="relative px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
            title="Ask Claude to write a recommendation for every pending alert without one"
          >
            {suggesting ? "Thinking..." : "Suggest all"}
          </button>
          <button
            onClick={runDetect}
            disabled={detecting}
            className="relative px-3 py-1.5 text-xs font-medium rounded-lg border border-edge text-ink-dim hover:text-ink disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
          >
            {detecting ? "Scanning..." : "Scan now"}
          </button>
          {/* flex-wrap INSIDE the group: the 7-pill row is ~470px — wider
              than a 390px viewport — so wrapping only at the parent level
              still overflowed (the group wraps as one block). */}
          <div className="flex flex-wrap gap-1 p-1 rounded-lg border border-edge bg-panel">
            {FILTER_OPTIONS.map((opt) => {
              const badge =
                opt.value === "pending"
                  ? totalPending
                  : opt.value === "review"
                    ? reviewCount
                    : opt.value === "armed"
                      ? armedCount
                      : opt.value === "conflicts"
                        ? conflictCount
                        : opt.value === "emails" && emailsLoaded
                          ? sentEmails.length
                          : 0;
              return (
                <button
                  key={opt.value}
                  onClick={() => selectFilter(opt.value)}
                  className={`relative px-2.5 py-1 text-[11px] rounded transition-colors pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 ${
                    filter === opt.value
                      ? "bg-gold/15 text-gold-ink"
                      : "text-ink-faint hover:text-ink"
                  }`}
                >
                  {opt.label}
                  {badge > 0 && <span className="ml-1.5 font-mono">{badge}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {approveAllConfirm && (
        // gold-ink over amber-200: same both-themes contrast fix as the
        // per-card confirm block in ReviewRow.
        <div className="rounded-lg border border-gold/30 bg-gold/10 p-3 text-[12px] text-gold-ink flex items-center justify-between gap-3 flex-wrap">
          <span>
            {approveAllConfirm.ids.length} of {approveAllConfirm.total} were not armed:{" "}
            {[
              approveAllConfirm.wouldFireCount > 0
                ? `${approveAllConfirm.wouldFireCount} already past their levels (would fire immediately)`
                : null,
              approveAllConfirm.beyondRangeCount > 0
                ? `${approveAllConfirm.beyondRangeCount} outside the scanner's range (would never alert)`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            — arm those too?
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={confirmApproveAllForce}
              disabled={approvingAll}
              className="relative px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
            >
              Confirm
            </button>
            <button
              onClick={cancelApproveAllForce}
              disabled={approvingAll}
              className="relative px-3 py-1 text-[11px] rounded text-ink-dim hover:text-ink disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {actionStatus && (
        <div className="rounded-lg border border-edge bg-panel px-4 py-2.5 text-[11px] text-ink-dim flex items-center justify-between">
          <span>{actionStatus}</span>
          <button
            onClick={() => setActionStatus(null)}
            className="text-ink-faint hover:text-ink text-xs"
            aria-label="Dismiss status"
          >
            ×
          </button>
        </div>
      )}

      {!isArmed && !isConflicts && !isEmails && sortedItems.length > 1 && (
        <SortPicker options={SORT_OPTIONS} sort={sort} onSort={setSort} />
      )}

      {isEmails ? (
        !emailsLoaded ? (
          <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
        ) : sentEmails.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <SentEmailsList emails={sentEmails} />
        )
      ) : isConflicts ? (
        loading && conflicts.length === 0 ? (
          <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
        ) : conflicts.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ConflictsList conflicts={conflicts} onConfirmed={refresh} />
        )
      ) : isArmed ? (
        loading && armedLevels.length === 0 ? (
          <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
        ) : armedLevels.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ArmedLevelsList levels={armedLevels} />
        )
      ) : loading && sortedItems.length === 0 ? (
        <p className="text-[11px] text-ink-faint italic py-6 text-center">Loading...</p>
      ) : sortedItems.length === 0 ? (
        <EmptyState filter={filter} />
      ) : isPending ? (
        <SplitPendingStream
          items={sortedItems}
          onRespond={respond}
          onDecideReview={decideReview}
          forceConfirm={forceConfirm}
          onCancelConfirm={cancelForceConfirm}
        />
      ) : isReview ? (
        <ReviewGroupedByAuthor
          // sortedItems, not raw reviewLevels — the Sort picker reorders the
          // stream, and Review must honor it like every other tab. Under
          // the default sort we still group by author below; under an
          // explicit sort, grouping would apply this order WITHIN each
          // author's fixed-order bucket and leave the buckets themselves
          // unsorted, so `sort` decides whether to keep one flat section.
          levels={sortedItems.flatMap((it) => (it.kind === "review" ? [it.level] : []))}
          sort={sort}
          onDecide={decideReview}
          disabled={approvingAll || decidingId !== null}
          busyId={decidingId}
          forceConfirm={forceConfirm}
          onCancelConfirm={cancelForceConfirm}
        />
      ) : (
        <ul className="space-y-2">
          {sortedItems.map((it) =>
            it.kind === "alert" ? (
              <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={respond} />
            ) : (
              <ReviewRow
                key={`r-${it.level.id}`}
                level={it.level}
                onDecide={decideReview}
                disabled={approvingAll || decidingId !== null}
                busyId={decidingId}
              />
            )
          )}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ filter }: { filter: StreamFilter }) {
  if (filter === "armed") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">No armed levels.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          Levels you add (or approve from Review) arm automatically and show here with their
          distance to trigger. Add levels on any{" "}
          <Link href="/dashboard/accounts?id=all#holdings" className="text-gold-ink underline">
            security detail page
          </Link>
          .
        </p>
      </div>
    );
  }
  if (filter === "review") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">Nothing to review.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          When the research sync extracts new levels, they appear here for your approval before
          the scan arms them.
        </p>
      </div>
    );
  }
  if (filter === "emails") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">No earnings emails sent yet.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          Preview and recap emails sent for held or watchlisted reporters archive here —
          click any row to re-read the full email.
        </p>
      </div>
    );
  }
  if (filter === "conflicts") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-10 text-center">
        <p className="text-sm text-ink-dim">No date conflicts.</p>
        <p className="text-[11px] text-ink-faint mt-2">
          Every upcoming earnings date agrees across Finnhub and Nasdaq. When they disagree,
          the rows show up here for you to confirm against IBKR.
        </p>
      </div>
    );
  }
  const label = filter === "all" ? "" : filter;
  return (
    <div className="rounded-xl border border-edge bg-panel p-10 text-center">
      <p className="text-sm text-ink-dim">No {label} alerts.</p>
      <p className="text-[11px] text-ink-faint mt-2">
        Alerts fire when a price crosses a level you&apos;ve set. Add levels on any{" "}
        <Link href="/dashboard/accounts?id=all#holdings" className="text-gold-ink underline">
          security detail page
        </Link>
        .
      </p>
    </div>
  );
}

// ─── Sent earnings emails archive view ──────────────────────────────
// Every completed preview/recap send, newest-first, re-readable via the
// existing viewer. Spec: docs/superpowers/specs/2026-07-28-earnings-email-
// archive-design.md (qa: earnings-emails--unreachable-after-week-rollover).

function fmtSentAt(sentAt: string): string {
  // sent_at is SQLite datetime('now') — UTC with a space separator.
  const d = new Date(sentAt.replace(" ", "T") + (sentAt.includes("Z") ? "" : "Z"));
  if (isNaN(d.getTime())) return sentAt;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function SentEmailsList({ emails }: { emails: SentEarningsEmail[] }) {
  const [symbolFilter, setSymbolFilter] = useState("");
  const [viewing, setViewing] = useState<SentEarningsEmail | null>(null);

  const filtered = symbolFilter.trim()
    ? emails.filter((e) =>
        e.symbol.toUpperCase().includes(symbolFilter.trim().toUpperCase())
      )
    : emails;

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={symbolFilter}
        onChange={(e) => setSymbolFilter(e.target.value)}
        placeholder="Filter by symbol…"
        className="w-full max-w-xs rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-gold/50"
      />
      {filtered.length === 0 ? (
        <p className="text-[11px] text-ink-faint italic py-6 text-center">
          No sent emails match &ldquo;{symbolFilter.trim()}&rdquo;.
        </p>
      ) : (
        <div className="rounded-xl border border-edge bg-panel divide-y divide-edge">
          {filtered.map((e) => (
            <button
              key={`${e.event_id}-${e.phase}`}
              onClick={() => setViewing(e)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-raised transition-colors"
              title={`Open the ${e.phase} email for ${e.symbol}`}
            >
              <span className="font-mono text-sm text-ink w-16 shrink-0">{e.symbol}</span>
              <Chip tone={e.phase === "preview" ? "gold" : "info"} size="xs">
                {e.phase}
              </Chip>
              <span className="text-[11px] text-ink-dim">
                reports {e.event_date}
              </span>
              {e.sent_by_cloud === 1 && (
                <Chip tone="neutral" size="xs">cloud</Chip>
              )}
              <span className="ml-auto text-[11px] text-ink-faint font-mono">
                sent {fmtSentAt(e.sent_at)}
              </span>
            </button>
          ))}
        </div>
      )}
      {viewing && (
        <EarningsEmailViewer
          eventId={viewing.event_id}
          phase={viewing.phase}
          open
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
}

// ─── Earnings date conflicts view ───────────────────────────────────
// The mobile-reachable surface for the NotificationBell's conflict count —
// pre-fix those rows were only resolvable via the desktop EarningsHub, so on
// touch the badge could never be cleared. Reuses EarningsDateChip verbatim
// (its popover is the whole Nasdaq/Finnhub/custom confirm workflow).

function fmtConflictDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function ConflictsList({
  conflicts,
  onConfirmed,
}: {
  conflicts: EarningsDateConflict[];
  onConfirmed: () => void;
}) {
  return (
    <ul className="space-y-2">
      {conflicts.map((c) => {
        const altDate = c.date_conflict_with?.split(":")[1] ?? null;
        return (
          <li
            key={c.id}
            className="rounded-xl border border-edge bg-panel px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
          >
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[13px] font-medium text-ink">
                  {c.symbol && c.security_id != null ? (
                    <SymbolLink securityId={c.security_id} symbol={c.symbol} />
                  ) : (
                    c.symbol ?? "—"
                  )}
                </span>
                <span className="text-[11px] text-ink-dim">
                  Nasdaq {fmtConflictDate(c.event_date)}
                  {altDate && altDate !== c.event_date && (
                    <> · Finnhub {fmtConflictDate(altDate)}</>
                  )}
                </span>
              </div>
              <p className="text-[10px] text-ink-faint mt-0.5">
                Sources disagree — confirm the date against IBKR.
              </p>
            </div>
            <EarningsDateChip
              symbol={c.symbol ?? ""}
              eventDate={c.event_date}
              releaseTime={c.release_time}
              dateStatus="conflict"
              dateConflictWith={c.date_conflict_with}
              onConfirmed={onConfirmed}
              popoverAlign="right"
            />
          </li>
        );
      })}
    </ul>
  );
}

// ─── Armed levels view (U3) ─────────────────────────────────────────

function ArmedLevelsList({ levels }: { levels: ArmedLevelView[] }) {
  const { sort, setSort } = useSortParam<ArmedSortField>("armedLevels", "nearest", "asc");

  const sorted = useMemo(() => {
    const field = sort.field;
    if (!field) return levels;
    const getValue = (l: ArmedLevelView): unknown => {
      if (field === "nearest") return l.distance_pct === null ? null : Math.abs(l.distance_pct);
      if (field === "symbol") return l.symbol;
      if (field === "level_price") return l.effective_price ?? l.price;
      if (field === "source_author") return l.source_author;
      if (field === "level_type") return l.level_type;
      return null;
    };
    return [...levels].sort((a, b) => compareValues(getValue(a), getValue(b), sort.dir));
  }, [levels, sort]);

  return (
    <div className="space-y-3">
      {levels.length > 1 && (
        <SortPicker options={ARMED_SORT_OPTIONS} sort={sort} onSort={setSort} />
      )}
      <ul className="divide-y divide-edge rounded-xl border border-edge bg-panel">
        {sorted.map((l) => (
          <ArmedLevelRow key={l.id} level={l} />
        ))}
      </ul>
    </div>
  );
}

function ArmedLevelRow({ level: l }: { level: ArmedLevelView }) {
  const typeLabel = LEVEL_TYPE_LABEL[l.level_type] ?? l.level_type;
  const isStatic = l.price_source === "static";
  const dist = l.distance_pct;
  // "X% away" reads cleanest as an absolute gap; the level type + direction +
  // the live price column tell the user which side of the level price sits on.
  const distanceLabel = dist === null ? null : `${formatPercent(Math.abs(dist) * 100)} away`;
  const near = dist !== null && Math.abs(dist) <= 0.02; // within 2% — about to fire
  // Armed in the DB, but the scanner skips it on every pass. Saying "171% away"
  // and nothing else read as live coverage — this row is not being monitored.
  const beyondScanRange = l.beyond_scan_range === true;
  // The scanner's other skip condition: the "Now" price below is weeks old, so
  // the distance chip is describing a stale market and no scan will act on it.
  const stalePrice = l.price_is_stale === true;

  return (
    <li className="py-2.5 px-3 flex items-start gap-3">
      {/* OCC symbols render compact ("GOOGL $220C 1/15/27") — the raw 21-char
          form's unbroken second token overflowed this 64px cell horizontally
          and overpainted the source line ("270115C00220000eep Dives:"). */}
      <div className="w-16 shrink-0 pt-0.5 font-mono text-[12px] font-medium text-ink break-words">
        <SymbolLink
          securityId={l.security_id}
          symbol={formatCompactOptionSymbol(l.symbol)}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] uppercase tracking-wide font-semibold text-ink-dim">
            {typeLabel}
          </span>
          {isStatic ? (
            <span className="text-sm font-mono font-medium text-ink">
              {formatUSDPrecise(l.price)}
            </span>
          ) : (
            <>
              <span className="text-sm font-mono font-medium text-ink">
                {formatPriceSourceLabel(l.price_source)}
              </span>
              {l.effective_price !== null ? (
                <span className="text-[10px] text-ink-faint">
                  ≈ {formatUSDPrecise(l.effective_price)}
                </span>
              ) : (
                <span className="text-[10px] text-amber-400">insufficient history</span>
              )}
            </>
          )}
          {l.direction && (
            <span className="text-[11px] font-medium text-ink-dim uppercase tracking-wide">
              {l.direction}
            </span>
          )}
          {distanceLabel && (
            <Chip size="xs" tone={near ? "warn" : "neutral"}>
              {distanceLabel}
            </Chip>
          )}
          {beyondScanRange && (
            <Chip size="xs" tone="down" title={BEYOND_SCAN_RANGE_EXPLANATION}>
              {BEYOND_SCAN_RANGE_LABEL}
            </Chip>
          )}
          {stalePrice && (
            <Chip size="xs" tone="warn" title={STALE_PRICE_EXPLANATION}>
              {STALE_PRICE_LABEL}
            </Chip>
          )}
          {l.action_hint && (
            <Chip size="xs" tone="neutral">
              {l.action_hint.replace("_", " ")}
            </Chip>
          )}
        </div>
        {(l.thesis || l.source_author) && (
          <p className="text-[11px] text-ink-faint mt-0.5">
            {l.source_author && <span className="text-ink-dim">{l.source_author}: </span>}
            {l.thesis}
          </p>
        )}
      </div>
      {l.current_price !== null && (
        <div className="text-right shrink-0">
          {/* "Now" is a claim. When the close behind it is outside the scan
              window, date it instead of implying it's live. */}
          <div
            className="text-[10px] text-ink-faint uppercase tracking-wide"
            title={stalePrice ? STALE_PRICE_EXPLANATION : undefined}
          >
            {stalePrice && l.price_date ? l.price_date : "Now"}
          </div>
          <div className="text-sm font-mono text-ink-dim">
            {formatUSDPrecise(l.current_price)}
          </div>
        </div>
      )}
    </li>
  );
}

function SplitPendingStream({
  items,
  onRespond,
  onDecideReview,
  forceConfirm,
  onCancelConfirm,
}: {
  items: StreamItem[];
  onRespond: (id: number, response: AlertResponse, note?: string) => void;
  onDecideReview: (id: number, status: LevelReviewStatus, force?: boolean) => void;
  forceConfirm: ForceConfirmMap;
  onCancelConfirm: (id: number) => void;
}) {
  // Surface today's activity above older items so the user can act before
  // market close. Both fired alerts (triggered_at = today) and review levels
  // (created_at = today) bubble up.
  const today: StreamItem[] = [];
  const older: StreamItem[] = [];
  for (const it of items) {
    if (isToday(it.recencyAt)) today.push(it);
    else older.push(it);
  }

  return (
    <div className="space-y-5">
      {today.length > 0 && (
        <section>
          <h2 className="text-[11px] font-medium text-gold-ink uppercase tracking-wider mb-2">
            Today&apos;s activity{" "}
            <span className="text-ink-faint font-mono ml-1">{today.length}</span>
          </h2>
          <ul className="space-y-2">
            {today.map((it) =>
              it.kind === "alert" ? (
                <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={onRespond} />
              ) : (
                <ReviewRow
                  key={`r-${it.level.id}`}
                  level={it.level}
                  onDecide={onDecideReview}
                  confirm={forceConfirm[it.level.id]}
                  onCancelConfirm={onCancelConfirm}
                />
              )
            )}
          </ul>
        </section>
      )}
      {older.length > 0 && (
        <section>
          <h2 className="text-[11px] font-medium text-ink-dim uppercase tracking-wider mb-2">
            Older pending{" "}
            <span className="text-ink-faint font-mono ml-1">{older.length}</span>
          </h2>
          <ul className="space-y-2">
            {older.map((it) =>
              it.kind === "alert" ? (
                <AlertRow key={`a-${it.alert.id}`} alert={it.alert} onRespond={onRespond} />
              ) : (
                <ReviewRow
                  key={`r-${it.level.id}`}
                  level={it.level}
                  onDecide={onDecideReview}
                  confirm={forceConfirm[it.level.id]}
                  onCancelConfirm={onCancelConfirm}
                />
              )
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One rendered section of the Review tab. `author === null` means "no
 *  header — this is a single flat, globally-ordered section" (explicit
 *  sort); a non-null author means the classic author-grouped presentation
 *  (default sort). */
export interface ReviewSection {
  author: string | null;
  levels: PendingLevel[];
}

/** Default stream sort is "recency desc" (the useSortParam default for the
 *  "alerts" scope) — treat a null field the same way, since that's what an
 *  unset URL param resolves to before useSortParam applies its default. */
export function isDefaultStreamSort(sort: SortState<StreamSortField>): boolean {
  return (sort.field === null || sort.field === "recency") && sort.dir === "desc";
}

/**
 * Review tab grouping/ordering decision, extracted so it's unit-testable
 * without rendering. Under the default stream sort we group by
 * source_author so the user can triage one newsletter author at a time
 * (carries over the prior UX from /dashboard/levels/review) — group order
 * and within-group order both follow `levels`' input order. Under an
 * EXPLICIT sort (price/date/symbol), grouping would apply that order WITHIN
 * each author's fixed-order bucket and leave the buckets themselves
 * unsorted, silently un-sorting the page (codex advisory) — so an explicit
 * sort renders one flat section instead, preserving `levels`' global order.
 * `levels` is assumed pre-sorted by the caller (sortedItems).
 */
export function buildReviewSections(
  levels: PendingLevel[],
  sort: SortState<StreamSortField>,
): ReviewSection[] {
  if (!isDefaultStreamSort(sort)) {
    return [{ author: null, levels }];
  }
  const grouped = new Map<string, PendingLevel[]>();
  for (const l of levels) {
    const key = l.source_author ?? "Unknown";
    const arr = grouped.get(key) ?? [];
    arr.push(l);
    grouped.set(key, arr);
  }
  return Array.from(grouped.entries()).map(([author, rows]) => ({ author, levels: rows }));
}

function ReviewGroupedByAuthor({
  levels,
  sort,
  onDecide,
  disabled,
  busyId,
  forceConfirm,
  onCancelConfirm,
}: {
  levels: PendingLevel[];
  sort: SortState<StreamSortField>;
  onDecide: (id: number, status: LevelReviewStatus, force?: boolean) => void;
  disabled: boolean;
  busyId?: number | null;
  forceConfirm: ForceConfirmMap;
  onCancelConfirm: (id: number) => void;
}) {
  const sections = buildReviewSections(levels, sort);
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.author ?? "__flat__"}>
          {section.author !== null && (
            <h2 className="text-[11px] uppercase tracking-wider text-ink-dim mb-2">
              {section.author}
              <span className="ml-1.5 text-ink-faint font-mono">{section.levels.length}</span>
            </h2>
          )}
          <ul className="space-y-2">
            {section.levels.map((l) => (
              <ReviewRow
                key={l.id}
                level={l}
                onDecide={onDecide}
                disabled={disabled}
                busyId={busyId}
                confirm={forceConfirm[l.id]}
                onCancelConfirm={onCancelConfirm}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AlertRow({
  alert,
  onRespond,
}: {
  alert: EnrichedAlert;
  onRespond: (id: number, response: AlertResponse, note?: string) => void;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  const when = new Date(alert.triggered_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let context: {
    held?: Array<{ account: string; quantity: number }>;
    onWatchlist?: boolean;
    watchlistGroup?: string | null;
  } = {};
  try {
    if (alert.position_context) context = JSON.parse(alert.position_context);
  } catch {
    // ignore malformed JSON
  }

  const isPending = alert.user_response === "pending";
  const responseLabel: Record<AlertResponse, { label: string; color: string }> = {
    pending: { label: "Pending", color: "text-gold-ink" },
    acted: { label: "Acted", color: "text-emerald-400" },
    ignored: { label: "Ignored", color: "text-ink-faint" },
    dismissed: { label: "Dismissed", color: "text-ink-faint" },
  };

  return (
    <li className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-gold/15 text-gold-ink uppercase tracking-wider"
              title="Fired alert — a level you set was crossed"
            >
              Alert
            </span>
            {alert.symbol && (
              <Link
                href={`/dashboard/security/${alert.security_id}`}
                className="font-mono text-sm font-medium text-ink hover:text-gold"
              >
                {alert.symbol}
              </Link>
            )}
            {alert.level && (
              <span className="text-[11px] text-ink-dim">
                {alert.level.level_type.replace("_", " ")} @{" "}
                {formatUSDPrecise(alert.level.price)}
                {alert.level.price_source && alert.level.price_source !== "static" && (
                  <span
                    className="ml-1.5 inline-block px-1 py-0.5 rounded text-[9px] bg-raised text-ink-faint uppercase tracking-wider"
                    title="This level references a moving average — the trigger price is the MA value at the moment of the cross, not a fixed number."
                  >
                    {formatPriceSourceLabel(alert.level.price_source)}
                  </span>
                )}
              </span>
            )}
            <span className="text-[11px] text-ink-faint">
              hit {formatUSDPrecise(alert.triggered_price)}
            </span>
            <span className="text-[10px] text-ink-faint">{when}</span>
          </div>

          {alert.level?.source_author && (
            <p className="text-[11px] text-ink-dim mt-1">
              <span className="text-ink-faint">Source: </span>
              {alert.level.source_author}
              {alert.level.thesis && <> — {alert.level.thesis}</>}
            </p>
          )}

          {(context.held?.length || context.onWatchlist) && (
            <p className="text-[11px] text-ink-faint mt-1">
              {context.held && context.held.length > 0 && (
                <span>
                  Holding:{" "}
                  {context.held.map((h, i) => (
                    <span key={`${h.account}-${i}`}>
                      {i > 0 && ", "}
                      <Shares value={h.quantity} /> in {h.account}
                    </span>
                  ))}
                </span>
              )}
              {context.held && context.held.length > 0 && context.onWatchlist && " · "}
              {context.onWatchlist && (
                <span>
                  On watchlist
                  {context.watchlistGroup && context.watchlistGroup !== "default"
                    ? ` (${context.watchlistGroup.replace(/_/g, " ")})`
                    : ""}
                </span>
              )}
            </p>
          )}

          {alert.suggested_action && (
            <div className="mt-2 px-3 py-1.5 rounded border border-gold/20 bg-gold/5 text-[11px] text-gold-ink">
              {/* AI prose embeds portfolio figures at generation time — mask the whole block */}
              <PrivateText>{alert.suggested_action}</PrivateText>
            </div>
          )}

          {!isPending && alert.user_response_note && (
            <p className="text-[11px] text-ink-faint italic mt-2">
              {/* Trade notes carry share counts / execution prices — portfolio-derived */}
              Note: <PrivateText>{alert.user_response_note}</PrivateText>
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isPending ? (
            <>
              <button
                onClick={() => setNoteOpen(!noteOpen)}
                className="relative px-2.5 py-1 text-[11px] rounded bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
              >
                Acted
              </button>
              <button
                onClick={() => onRespond(alert.id, "ignored")}
                className="relative px-2.5 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
              >
                Ignore
              </button>
              <button
                onClick={() => onRespond(alert.id, "dismissed")}
                className="relative text-ink-faint hover:text-ink text-xs pointer-coarse:p-2 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5"
                title="Dismiss"
              >
                ×
              </button>
            </>
          ) : (
            <span className={`text-[11px] ${responseLabel[alert.user_response].color}`}>
              {responseLabel[alert.user_response].label}
            </span>
          )}
        </div>
      </div>

      {noteOpen && isPending && (
        <div className="mt-3 flex items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Bought 50 shares at $175.20"
            className="flex-1 bg-canvas border border-edge rounded px-2 py-1 text-xs"
            autoFocus
          />
          <button
            onClick={() => {
              onRespond(alert.id, "acted", note || undefined);
              setNoteOpen(false);
              setNote("");
            }}
            className="px-3 py-1 text-[11px] rounded bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
          >
            Log
          </button>
          <button
            onClick={() => {
              setNoteOpen(false);
              setNote("");
            }}
            className="text-ink-faint hover:text-ink text-xs"
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

function ReviewRow({
  level,
  onDecide,
  disabled,
  busyId,
  confirm,
  onCancelConfirm,
}: {
  level: PendingLevel;
  onDecide: (id: number, status: LevelReviewStatus, force?: boolean) => void;
  disabled?: boolean;
  /** The level id whose review PATCH is currently in flight (spinner label). */
  busyId?: number | null;
  /** Set when approving was refused with a 409 — `reason` picks the copy. */
  confirm?: { currentPrice: number; effectivePrice: number; reason: ArmRefusalReason };
  onCancelConfirm?: (id: number) => void;
}) {
  const busy = busyId === level.id;
  const distVal = distancePct(level.price, level.current_price);
  // Pre-decision disclosure: a mis-scaled extracted level (SPX prices on SPY)
  // used to look like any other pending row and approve silently into coverage
  // the scanner skips forever. Static levels only — an MA level's effective
  // price is resolved server-side and isn't on this row to judge.
  const beyondScanRange =
    level.price_source === "static" &&
    isLevelBeyondScanRange(level.price, level.current_price, level.security_type);
  const when = new Date(level.created_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <li className="rounded-xl border border-edge bg-panel p-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="inline-block px-1.5 py-0.5 rounded text-[9px] bg-amber-500/20 text-amber-500 uppercase tracking-wider"
              title="Newsletter-extracted level awaiting your approval before it arms"
            >
              Review
            </span>
            <Link
              href={`/dashboard/security/${level.security_id}`}
              className="font-mono text-sm font-medium text-ink hover:text-gold"
            >
              {level.symbol}
            </Link>
            <span className="text-[11px] text-ink-dim uppercase">
              {level.level_type.replace("_", " ")}
            </span>
            <span className="text-sm font-mono text-ink">
              @ {formatUSDPrecise(level.price)}
            </span>
            {level.price_source && level.price_source !== "static" && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-raised text-ink-faint uppercase tracking-wider">
                {formatPriceSourceLabel(level.price_source)}
              </span>
            )}
            {distVal !== null && (
              <span className="text-[11px] text-ink-faint font-mono">
                {distVal >= 0 ? "+" : ""}
                {formatPercent(distVal, 1)} vs{" "}
                {level.current_price != null ? formatUSDPrecise(level.current_price) : "—"}
              </span>
            )}
            {beyondScanRange && (
              <Chip size="xs" tone="down" title={BEYOND_SCAN_RANGE_EXPLANATION}>
                {BEYOND_SCAN_RANGE_LABEL}
              </Chip>
            )}
            <span className="text-[10px] text-ink-faint">{when}</span>
          </div>
          {level.source_author && (
            <p className="text-[11px] text-ink-dim mt-1">
              <span className="text-ink-faint">Source: </span>
              {level.source_author}
              {level.thesis && <> — {level.thesis}</>}
            </p>
          )}
          {level.timeframe && (
            <p className="text-[10px] text-ink-faint mt-1">Timeframe: {level.timeframe}</p>
          )}
          {confirm && (
            // gold-ink, not amber-200: the amber palette is dark-tuned and
            // composites to ~1.1:1 on the light theme's white panel — the
            // gold-ink token is the house pair for readable small gold text
            // in BOTH themes (4.5:1+ each side).
            <div className="mt-2 rounded-lg border border-gold/30 bg-gold/10 p-2 text-[11px] text-gold-ink">
              {confirm.reason === "beyond_scan_range" ? (
                <>
                  This level ({formatUSDPrecise(confirm.effectivePrice)}) is more than{" "}
                  {formatPercent(
                    Math.abs(
                      distancePct(confirm.effectivePrice, confirm.currentPrice) ?? 0,
                    ),
                    0,
                  )}{" "}
                  from the current price ({formatUSDPrecise(confirm.currentPrice)}) — the
                  scanner skips it on every pass, so arming it can never produce an alert.
                  Check for a mis-scaled price. Arm anyway?
                </>
              ) : (
                <>
                  Price {formatUSDPrecise(confirm.currentPrice)} is already past this level (
                  {formatUSDPrecise(confirm.effectivePrice)}) — arming will fire an alert on
                  the next scan. Arm anyway?
                </>
              )}
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => onDecide(level.id, "auto_approved", true)}
                  disabled={disabled}
                  className="relative px-3 py-1 text-[11px] font-semibold rounded border border-gold-ink/40 text-gold-ink hover:bg-gold/10 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
                >
                  {busy ? "Arming…" : "Confirm"}
                </button>
                <button
                  onClick={() => onCancelConfirm?.(level.id)}
                  disabled={disabled}
                  className="relative px-3 py-1 text-[11px] rounded text-ink-dim hover:text-ink disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        {!confirm && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => onDecide(level.id, "auto_approved")}
              disabled={disabled}
              className="relative px-3 py-1 text-[11px] rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
            >
              {busy ? "Checking…" : "Approve"}
            </button>
            <button
              onClick={() => onDecide(level.id, "rejected")}
              disabled={disabled}
              className="relative px-3 py-1 text-[11px] rounded text-ink-faint hover:text-ink-dim disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2.5 pointer-coarse:after:-inset-x-0.5"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </li>
  );
}
