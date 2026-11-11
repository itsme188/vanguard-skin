"use client";

/**
 * The position-concentration limits, per account scope.
 *
 * These are the limits the What-if calculator checks a hypothetical trade
 * against, and the ceiling the cash-deploy suggestions will not push a single
 * position past. They are set PER SCOPE on purpose: the four seeded scopes do
 * not share one set of numbers, because a Roth is run differently from a
 * taxable account or a brokerage margin account. Editing one scope leaves the
 * other three exactly as they were.
 *
 * Stored in the SQLite `settings` table, so a change counts from the next
 * calculation with no restart.
 *
 * UNIT: the three caps are shown as percentages (10 means 10% of the scope's
 * market value) while the stored value is a fraction (0.10). The conversion
 * happens here, in `toStored` / `toShown`, and the labels say "%" so the owner
 * is never guessing which one a box wants. The beta band is a plain multiple
 * of the market, not a percentage.
 */

import { useState } from "react";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { CAP_SCOPE_LABELS, type CapScope, type Caps } from "./preferences-client";
import { usePreferences } from "./usePreferences";

/** A fraction (0.10) as the percentage shown in the box (10). */
function toShown(fraction: number): string {
  return String(Math.round(fraction * 10000) / 100);
}

/** A percentage typed in the box (10) as the stored fraction (0.10). */
function toStored(shown: string): number {
  return Number((Number(shown) / 100).toFixed(6));
}

type CapsDraft = Partial<Record<keyof Caps, string>>;

const PERCENT_FIELDS: { field: keyof Caps; label: string; help: string }[] = [
  {
    field: "top1Max",
    label: "Largest position, max %",
    help: "No single holding above this share of the scope.",
  },
  {
    field: "top3Max",
    label: "Top three together, max %",
    help: "The three biggest holdings added up. Must be at least the single-position cap.",
  },
  {
    field: "sectorMax",
    label: "One sector, max %",
    help: "Everything in one sector added up.",
  },
];

export function ConstructionCapsPreferences() {
  const { prefs, message, saving, save } = usePreferences();
  const [drafts, setDrafts] = useState<Partial<Record<CapScope, CapsDraft>>>({});

  function shownValue(scope: CapScope, field: keyof Caps): string {
    const typed = drafts[scope]?.[field];
    if (typed !== undefined) return typed;
    const stored = prefs?.constructionCaps[scope];
    if (!stored) return "";
    const isPercent = field !== "betaMin" && field !== "betaMax";
    return isPercent ? toShown(stored[field]) : String(stored[field]);
  }

  function setDraft(scope: CapScope, field: keyof Caps, value: string) {
    setDrafts((prev) => ({ ...prev, [scope]: { ...prev[scope], [field]: value } }));
  }

  async function saveScope(scope: CapScope) {
    const stored = prefs?.constructionCaps[scope];
    if (!stored) return;
    const next: Caps = {
      top1Max: toStored(shownValue(scope, "top1Max")),
      top3Max: toStored(shownValue(scope, "top3Max")),
      sectorMax: toStored(shownValue(scope, "sectorMax")),
      betaMin: Number(shownValue(scope, "betaMin")),
      betaMax: Number(shownValue(scope, "betaMax")),
    };
    const label = CAP_SCOPE_LABELS.find((s) => s.scope === scope)?.label ?? scope;
    if (await save({ constructionCaps: { [scope]: next } }, `save the limits for ${label}`)) {
      setDrafts((prev) => ({ ...prev, [scope]: undefined }));
    }
  }

  return (
    <div className="px-5 py-4 space-y-5">
      {message && (
        <p role="alert" className="text-[12px] text-down">
          {message}
        </p>
      )}
      {!prefs && <p className="text-[12px] text-ink-faint">Loading the limits…</p>}

      {prefs &&
        CAP_SCOPE_LABELS.map(({ scope, label }) => {
          const dirty = drafts[scope] !== undefined;
          return (
            <div key={scope} className="space-y-2 pb-4 border-b border-edge/60 last:border-b-0 last:pb-0">
              <h3 className="text-[13px] font-medium text-ink">{label}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {PERCENT_FIELDS.map(({ field, label: fieldLabel, help }) => (
                  <div key={field} className="space-y-1">
                    <label
                      htmlFor={`caps-${scope}-${field}`}
                      className="block text-[12px] text-ink-dim"
                    >
                      {fieldLabel}
                    </label>
                    <input
                      id={`caps-${scope}-${field}`}
                      type="number"
                      inputMode="decimal"
                      step="0.5"
                      min="0"
                      max="100"
                      value={shownValue(scope, field)}
                      onChange={(e) => setDraft(scope, field, e.target.value)}
                      className="w-full px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
                    />
                    <p className="text-[11px] text-ink-faint">{help}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-1">
                <p className="text-[12px] text-ink-dim">
                  Beta band — how much the scope may move relative to the market. 1.0 means it
                  moves with the market; 0.7 to 1.2 allows a little either side.
                </p>
                <div className="flex items-center gap-2">
                  <label htmlFor={`caps-${scope}-betaMin`} className="text-[12px] text-ink-dim">
                    from
                  </label>
                  <input
                    id={`caps-${scope}-betaMin`}
                    type="number"
                    inputMode="decimal"
                    step="0.05"
                    min="0"
                    max="5"
                    value={shownValue(scope, "betaMin")}
                    onChange={(e) => setDraft(scope, "betaMin", e.target.value)}
                    className="w-24 px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
                  />
                  <label htmlFor={`caps-${scope}-betaMax`} className="text-[12px] text-ink-dim">
                    to
                  </label>
                  <input
                    id={`caps-${scope}-betaMax`}
                    type="number"
                    inputMode="decimal"
                    step="0.05"
                    min="0"
                    max="5"
                    value={shownValue(scope, "betaMax")}
                    onChange={(e) => setDraft(scope, "betaMax", e.target.value)}
                    className="w-24 px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
                  />
                  <button
                    type="button"
                    onClick={() => saveScope(scope)}
                    disabled={saving || !dirty}
                    className={`ml-auto px-3 py-1 text-xs font-medium rounded-lg ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors`}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}
