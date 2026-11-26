"use client";

import { GAINS_AT_RISK_DRIVERS, type GainsAtRiskDriver } from "@/lib/analysis/gains-at-risk-input";
import {
  DRIVER_KIND_LABELS,
  DRIVERS_LOAD_FAILED_TEXT,
  NO_SINGLE_NAME_TEXT,
  driverFromOptionValue,
  driverOptionLabel,
  driverOptionValue,
  type DriverChoice,
} from "@/lib/analysis/gains-at-risk-view";
// Type only: no query or engine code reaches the browser.
import type { SingleNameDriverEntry } from "@/lib/compute/gains-at-risk-drivers";

/**
 * The driver control (Gains at risk step 3, P1): two kinds, picked by radio.
 * "Index" keeps today's three pills; "One stock or fund" is a native select
 * of the server-built list (no carets, house rule; no free text). The index
 * pick is kept while a single name is tried, so switching back restores it.
 */
export function DriverControl({
  driver,
  indexSymbol,
  drivers,
  onPickIndex,
  onPickSingleName,
  listFailed = false,
  onRetry,
}: {
  driver: DriverChoice;
  indexSymbol: GainsAtRiskDriver;
  drivers: readonly SingleNameDriverEntry[];
  /** Switch to the index kind, or pick another index while on it. */
  onPickIndex: (symbol: GainsAtRiskDriver) => void;
  /** Switch to one stock or fund, or pick another name while on it. */
  onPickSingleName: (entry: SingleNameDriverEntry) => void;
  /** The list could not be loaded: the choice is disabled with a sentence and a retry; the index keeps working. */
  listFailed?: boolean;
  onRetry?: () => void;
}) {
  const single = driver.kind === "single-name" ? driver.entry : null;
  // The select shows the chosen name; before one is chosen, the first on the list.
  const selectValue = single ? driverOptionValue(single) : drivers[0] ? driverOptionValue(drivers[0]) : "";

  return (
    <fieldset className="space-y-2 min-w-0 max-w-full">
      <legend className="block text-xs text-ink-faint mb-1">What moves</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="relative inline-flex items-center gap-1.5 text-sm text-ink pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1 pointer-coarse:after:-inset-x-1">
          <input
            type="radio"
            name="gains-driver-kind"
            value="index"
            checked={driver.kind === "index"}
            onChange={() => onPickIndex(indexSymbol)}
          />
          {DRIVER_KIND_LABELS.index}
        </label>
        <div
          className="flex items-center gap-1 rounded-lg bg-raised border border-edge p-0.5 w-fit"
          role="group"
          aria-label="Index"
        >
          {GAINS_AT_RISK_DRIVERS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={driver.kind === "index" && indexSymbol === d}
              onClick={() => onPickIndex(d)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                driver.kind === "index" && indexSymbol === d ? "bg-panel text-ink shadow-sm" : "text-ink-dim hover:text-ink"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 min-w-0">
        <label className="relative inline-flex items-center gap-1.5 text-sm text-ink pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-1 pointer-coarse:after:-inset-x-1">
          <input
            type="radio"
            name="gains-driver-kind"
            value="single-name"
            checked={driver.kind === "single-name"}
            disabled={drivers.length === 0 && single === null}
            onChange={() => {
              const first = single ?? drivers[0];
              if (first) onPickSingleName(first);
            }}
          />
          {DRIVER_KIND_LABELS["single-name"]}
        </label>
        {listFailed && drivers.length === 0 ? (
          <span className="inline-flex flex-wrap items-center gap-2 text-xs text-ink-faint">
            {DRIVERS_LOAD_FAILED_TEXT}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="px-2 py-1 rounded-md border border-edge text-xs text-ink-dim hover:text-ink"
              >
                Try again
              </button>
            )}
          </span>
        ) : drivers.length > 0 ? (
          <select
            aria-label="Stock or fund"
            value={selectValue}
            onChange={(e) => {
              const entry = driverFromOptionValue(drivers, e.target.value);
              if (entry) onPickSingleName(entry);
            }}
            className="w-full sm:w-auto min-w-0 max-w-full px-2 py-1.5 rounded-md border border-edge bg-raised text-sm text-ink"
          >
            {drivers.map((e) => (
              <option key={driverOptionValue(e)} value={driverOptionValue(e)}>
                {driverOptionLabel(e)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-ink-faint">{NO_SINGLE_NAME_TEXT}</span>
        )}
      </div>
    </fieldset>
  );
}
