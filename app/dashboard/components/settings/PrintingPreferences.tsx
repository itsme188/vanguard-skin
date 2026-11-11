"use client";

/**
 * Two local-machine paths that previously had no screen at all: which printer
 * an earnings worksheet goes to, and where the `pdftotext` program lives.
 *
 * Both are rows in the SQLite `settings` table, so a change applies to the
 * next run with no restart. Each saves on its own button rather than on every
 * keystroke: a half-typed path would make the print-watch refuse a filing.
 *
 * A box shows the owner's unsaved text when they have typed something
 * (`draft !== null`) and the stored value otherwise, so a confirmed save puts
 * the screen back in step with the server without an effect that copies
 * props into state.
 */

import { useState } from "react";
import { CHIP_TONE_CLASSES } from "@/app/dashboard/components/Chip";
import { usePreferences } from "./usePreferences";

export function PrintingPreferences() {
  const { prefs, message, saving, save } = usePreferences();
  const [printerDraft, setPrinterDraft] = useState<string | null>(null);
  const [pdftotextDraft, setPdftotextDraft] = useState<string | null>(null);

  const printer = printerDraft ?? prefs?.worksheetPrinterName ?? "";
  const pdftotext = pdftotextDraft ?? prefs?.pdftotextPath ?? "";

  async function savePrinter() {
    if (await save({ worksheetPrinterName: printer }, "save the printer name")) {
      setPrinterDraft(null);
    }
  }

  async function savePdftotext() {
    if (await save({ pdftotextPath: pdftotext }, "save the pdftotext path")) {
      setPdftotextDraft(null);
    }
  }

  return (
    <div className="px-5 py-4 space-y-4">
      {message && (
        <p role="alert" className="text-[12px] text-down">
          {message}
        </p>
      )}

      <div className="space-y-1">
        <label htmlFor="worksheetPrinterName" className="block text-[13px] font-medium text-ink">
          Worksheet printer
        </label>
        <p className="text-[12px] text-ink-dim max-w-2xl">
          The printer an armed earnings worksheet is sent to, by its exact name in macOS. Leave it
          blank to use whichever printer is your default.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="worksheetPrinterName"
            type="text"
            value={printer}
            onChange={(e) => setPrinterDraft(e.target.value)}
            placeholder="Default printer"
            className="w-full max-w-md px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
          />
          <button
            type="button"
            disabled={saving || !prefs || printerDraft === null}
            onClick={savePrinter}
            className={`px-3 py-1 text-xs font-medium rounded-lg ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors`}
          >
            Save
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <label htmlFor="pdftotextPath" className="block text-[13px] font-medium text-ink">
          pdftotext program
        </label>
        <p className="text-[12px] text-ink-dim max-w-2xl">
          The full path to <code>pdftotext</code>, the small program that reads the words out of a
          PDF press release or filing. Leave it blank and the app looks in the usual Homebrew
          locations itself; set it when yours lives somewhere else.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="pdftotextPath"
            type="text"
            value={pdftotext}
            onChange={(e) => setPdftotextDraft(e.target.value)}
            placeholder="/opt/homebrew/bin/pdftotext"
            className="w-full max-w-md px-2 py-1.5 text-[13px] font-mono bg-raised border border-edge rounded text-ink"
          />
          <button
            type="button"
            disabled={saving || !prefs || pdftotextDraft === null}
            onClick={savePdftotext}
            className={`px-3 py-1 text-xs font-medium rounded-lg ${CHIP_TONE_CLASSES.gold} hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors`}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
