"use client";

/**
 * The coverage-gap ignore list — until now a JSON row in the settings table
 * with no screen at all.
 *
 * The coverage guard runs with the Sunday briefing and pushes a notification
 * naming any stock you hold or watch that looks due to report with no earnings
 * date on file. Some names can never be covered (a foreign listing the data
 * feed simply does not carry), so this list is the escape valve.
 *
 * Stored in the SQLite `settings` table: a change counts from the next run,
 * with no restart. Symbols are upper-cased and de-duplicated by the server.
 */

import { useState } from "react";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { usePreferences } from "./usePreferences";

export function CoverageGapIgnoredSymbols() {
  const { prefs, message, saving, save } = usePreferences();
  const [draft, setDraft] = useState("");

  const symbols = prefs?.coverageGuardIgnoredSymbols ?? [];

  async function add() {
    const sym = draft.trim().toUpperCase();
    if (!sym) return;
    if (symbols.includes(sym)) {
      setDraft("");
      return;
    }
    if (await save({ coverageGuardIgnoredSymbols: [...symbols, sym] }, `add ${sym} to the list`)) {
      setDraft("");
    }
  }

  function remove(sym: string) {
    void save(
      { coverageGuardIgnoredSymbols: symbols.filter((s) => s !== sym) },
      `remove ${sym} from the list`,
    );
  }

  return (
    <div className="px-5 py-4 space-y-2">
      <p className="block text-[13px] font-medium text-ink">
        Symbols to leave out of the coverage warning
      </p>
      <p className="text-[12px] text-ink-dim max-w-2xl">
        A symbol on this list never triggers the &ldquo;no earnings date on file&rdquo; notification.
        Use it for names the data feed cannot cover, so the real gaps stay visible. Nothing else
        about the symbol changes — it still appears everywhere else in the app.
      </p>

      {message && (
        <p role="alert" className="text-[12px] text-down">
          {message}
        </p>
      )}

      {symbols.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {symbols.map((sym) => (
            <span
              key={sym}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-mono bg-raised border border-edge rounded"
            >
              {sym}
              <button
                type="button"
                onClick={() => remove(sym)}
                disabled={saving}
                className="ml-0.5 text-ink-dim hover:text-down disabled:opacity-40"
                aria-label={`Stop ignoring ${sym}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-ink-faint pt-1">
          {prefs
            ? "No symbols are being left out, so every gap is reported."
            : "Loading the list…"}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Ticker"
          aria-label="Symbol to leave out of the coverage warning"
          className="w-32 px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
        />
        <button
          type="button"
          onClick={add}
          disabled={saving || !prefs || draft.trim() === ""}
          className={`px-3 py-1 text-xs font-medium rounded-lg ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors`}
        >
          Add
        </button>
      </div>
    </div>
  );
}
