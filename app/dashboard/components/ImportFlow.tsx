"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface SkippedRow {
  category: string;
  index: number;
  reason: string;
  symbol?: string;
}

interface PreviewResult {
  filename: string;
  success: boolean;
  error?: string;
  sourceType?: string;
  preview?: {
    transactionCount: number;
    securityCount: number;
    holdingCount: number;
    priceCount: number;
    snapshotCount: number;
  };
  skippedRows?: SkippedRow[];
  errors?: string[];
  warnings?: string[];
}

interface CommitResult {
  filename: string;
  success: boolean;
  error?: string;
  sourceType?: string;
  batchId?: number;
  committed?: {
    newTransactions: number;
    newHoldings: number;
    newPrices: number;
    newSnapshots: number;
    newSecurities: number;
    skippedDuplicates: number;
    totalRecords: number;
  };
}

type ImportState =
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "preview"; results: PreviewResult[] }
  | { status: "importing" }
  | { status: "done"; results: CommitResult[]; newTradePeriods?: { periodStart: string; periodEnd: string; tradeCount: number }[]; reconciliationFlags?: { accountName: string; snapshotDate: string; diffPct: number }[] }
  | { status: "error"; message: string };

export function ImportFlow() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<ImportState>({ status: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const handleFiles = useCallback(async (selectedFiles: File[]) => {
    if (selectedFiles.length === 0) return;

    setFiles(selectedFiles);
    setState({ status: "parsing" });

    try {
      const formData = new FormData();
      selectedFiles.forEach((f) => formData.append("files", f));

      const res = await fetch("/api/import?mode=preview", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
        setState({ status: "error", message: err.error ?? `Preview failed (${res.status})` });
        return;
      }

      const data = await res.json();

      if (!data.success) {
        setState({ status: "error", message: data.error });
        return;
      }

      setState({ status: "preview", results: data.results });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to parse files",
      });
    }
  }, []);

  const handleImport = useCallback(async () => {
    setState({ status: "importing" });

    try {
      const formData = new FormData();
      files.forEach((f) => formData.append("files", f));

      const res = await fetch("/api/import?mode=commit", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
        setState({ status: "error", message: err.error ?? `Import failed (${res.status})` });
        return;
      }

      const data = await res.json();

      if (!data.success) {
        setState({ status: "error", message: data.error });
        return;
      }

      setState({ status: "done", results: data.results, newTradePeriods: data.newTradePeriods, reconciliationFlags: data.reconciliationFlags });
      router.refresh();
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error ? err.message : "Failed to import files",
      });
    }
  }, [files, router]);

  const reset = useCallback(() => {
    setState({ status: "idle" });
    setFiles([]);
    setIsDragOver(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      const droppedFiles = Array.from(e.dataTransfer.files).filter(
        (f) => f.name.endsWith(".csv") || f.name.endsWith(".pdf")
      );
      handleFiles(droppedFiles);
    },
    [handleFiles]
  );

  // Idle / Parsing — drop zone
  if (state.status === "idle" || state.status === "parsing") {
    return (
      <div
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragOver(false);
        }}
        role="button"
        aria-label="File upload drop zone"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && state.status === "idle") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onClick={() => state.status === "idle" && fileInputRef.current?.click()}
        className={`
          relative rounded-xl border-2 border-dashed p-6 sm:p-12 text-center transition-[border-color,background-color,scale] cursor-pointer focus-ring
          ${
            isDragOver
              ? "border-gold bg-gold-glow scale-[1.005]"
              : "border-edge hover:border-edge-strong"
          }
          ${state.status === "parsing" ? "opacity-60 pointer-events-none" : ""}
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".csv,.pdf"
          className="hidden"
          onChange={(e) => {
            const selected = Array.from(e.target.files ?? []);
            handleFiles(selected);
          }}
        />

        {state.status === "parsing" ? (
          <div className="flex flex-col items-center gap-3" aria-live="polite">
            <div className="w-10 h-10 border-2 border-gold border-t-transparent rounded-full animate-spin" />
            <p className="text-ink-dim">Parsing files...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <svg
              className="w-10 h-10 text-ink-faint"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
              />
            </svg>
            <div>
              <p className="text-ink font-medium">
                Drop files here to import
              </p>
              <p className="text-ink-dim text-sm mt-1">
                Vanguard PDFs, IBKR CSVs, Vanguard CSVs, Canonical CSVs
              </p>
            </div>
            <span className="mt-2 px-4 py-2 rounded-lg bg-raised text-ink-dim text-sm hover:bg-muted hover:text-ink transition-colors">
              Browse Files
            </span>
          </div>
        )}
      </div>
    );
  }

  // Preview — show parsed results
  if (state.status === "preview") {
    // Only successfully-parsed files are importable. An "Unknown file format"
    // preview with an enabled Import button is a contradictory affordance
    // (QA 2026-07-12, third recurrence) — gate the action on parse success.
    const importableCount = state.results.filter((r) => r.success && r.preview).length;
    return (
      <div className="rounded-xl border border-edge bg-panel p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-medium text-ink">Import Preview</h3>
          <button
            onClick={reset}
            className="text-ink-faint hover:text-ink transition-colors p-1"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-3">
          {state.results.map((result, i) => (
            <div
              key={i}
              className="rounded-lg border border-edge bg-canvas p-4"
            >
              <div className="flex items-center gap-3 mb-3">
                <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span className="text-sm font-medium text-ink">
                  {result.filename}
                </span>
                {result.sourceType && (
                  <span className="text-xs px-2 py-0.5 rounded bg-blue/20 text-blue font-mono font-medium">
                    {result.sourceType}
                  </span>
                )}
                {(result.skippedRows?.length ?? 0) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gold/15 text-gold-ink font-medium">
                    {result.skippedRows!.length} skipped
                  </span>
                )}
                {(result.warnings?.length ?? 0) > 0 && !(result.skippedRows?.length) && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gold/20 text-gold-ink font-medium">
                    {result.warnings!.length} warning{result.warnings!.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {result.success && result.preview ? (
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2 text-center">
                  {(
                    [
                      ["Transactions", result.preview.transactionCount],
                      ["Securities", result.preview.securityCount],
                      ["Holdings", result.preview.holdingCount],
                      ["Prices", result.preview.priceCount],
                      ["Snapshots", result.preview.snapshotCount],
                    ] as const
                  ).map(([label, count]) => (
                    <div key={label} className="py-2">
                      <div className="text-lg font-mono font-semibold text-ink tabular-nums">
                        {count}
                      </div>
                      <div className="text-[11px] text-ink-faint">{label}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-down text-sm">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                  </svg>
                  {result.error}
                </div>
              )}

              {/* Skipped rows detail */}
              {result.skippedRows && result.skippedRows.length > 0 && (
                <details className="mt-3 rounded-lg border border-gold/20 bg-gold/5">
                  <summary className="px-3 py-2 text-xs font-medium text-gold-ink cursor-pointer hover:bg-gold/10 transition-colors">
                    {result.skippedRows.length} row{result.skippedRows.length !== 1 ? "s" : ""} will be excluded (invalid data)
                  </summary>
                  <div className="px-3 pb-2 space-y-1">
                    {result.skippedRows.slice(0, 20).map((row, j) => (
                      <p key={j} className="text-xs text-ink-dim font-mono">
                        <span className="text-gold/70">{row.category}[{row.index}]</span>
                        {row.symbol && <span className="text-ink-faint"> {row.symbol}</span>}
                        {" — "}{row.reason}
                      </p>
                    ))}
                    {result.skippedRows.length > 20 && (
                      <p className="text-xs text-ink-faint">
                        ...and {result.skippedRows.length - 20} more
                      </p>
                    )}
                  </div>
                </details>
              )}

              {/* Warnings */}
              {result.warnings && result.warnings.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-gold-ink cursor-pointer hover:text-gold/80">
                    {result.warnings.length} warning{result.warnings.length !== 1 ? "s" : ""}
                  </summary>
                  <div className="mt-1 space-y-0.5">
                    {result.warnings.map((w, j) => (
                      <p key={j} className="text-xs text-gold/80">
                        {w}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))}
        </div>

        <div className="flex gap-3 pt-2 items-center">
          <button
            onClick={handleImport}
            disabled={importableCount === 0}
            className="px-5 py-2.5 rounded-lg bg-gold text-canvas font-medium text-sm hover:brightness-110 transition-[filter,scale] active:scale-[0.96] focus-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:active:scale-100"
          >
            Import {importableCount} file{importableCount !== 1 ? "s" : ""}
          </button>
          {importableCount === 0 && (
            <span className="text-xs text-ink-faint">
              Nothing to import — no file matched a known format.
            </span>
          )}
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-lg border border-edge text-ink-dim text-sm hover:bg-raised transition-colors focus-ring"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Importing — spinner
  if (state.status === "importing") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-6 sm:p-12 text-center">
        <div className="w-10 h-10 border-2 border-gold border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-ink-dim mt-3">Importing data...</p>
      </div>
    );
  }

  // Done — success
  if (state.status === "done") {
    return (
      <div className="rounded-xl border border-edge bg-panel p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-up-tint flex items-center justify-center">
            <svg className="w-4 h-4 text-up" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-ink">Import Complete</h3>
        </div>

        <div className="space-y-2">
          {state.results.map((result, i) => (
            <div
              key={i}
              className="rounded-lg border border-edge bg-canvas p-3 flex items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-ink-faint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
                </svg>
                <span className="text-sm text-ink">{result.filename}</span>
              </div>
              {result.committed && (
                <span className="text-xs font-mono text-ink-dim tabular-nums">
                  {result.committed.totalRecords} records
                  {result.committed.skippedDuplicates > 0 && (
                    <span className="text-ink-faint">
                      {" "}
                      ({result.committed.skippedDuplicates} dupes skipped)
                    </span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Trade review prompt */}
        {state.newTradePeriods && state.newTradePeriods.length > 0 && (
          <a
            href={`/dashboard/analysis?view=trade-reviews`}
            className="block rounded-lg border border-gold/20 bg-gold/5 px-4 py-3 text-sm text-ink-dim hover:bg-gold/10 transition-colors"
          >
            <span className="text-gold-ink font-medium">Trade reviews available</span>
            {" — "}
            {state.newTradePeriods.length} month{state.newTradePeriods.length > 1 ? "s" : ""} with{" "}
            {state.newTradePeriods.reduce((s, p) => s + p.tradeCount, 0)} unreviewed trades.
            <span className="text-gold-ink ml-1">View →</span>
          </a>
        )}

        {/* Reconciliation flags */}
        {state.reconciliationFlags && state.reconciliationFlags.length > 0 && (
          <a
            href="/dashboard/data-health"
            className="block rounded-lg border border-down/20 bg-down/5 px-4 py-3 text-sm text-ink-dim hover:bg-down/10 transition-colors"
          >
            <span className="text-down font-medium">Reconciliation flags</span>
            {" — "}
            {state.reconciliationFlags.length} snapshot{state.reconciliationFlags.length !== 1 ? "s" : ""} differ &gt;2% from computed values.
            <span className="text-down ml-1">View Data Health →</span>
          </a>
        )}

        <button
          onClick={reset}
          className="px-5 py-2.5 rounded-lg border border-edge text-ink-dim text-sm hover:bg-raised transition-colors"
        >
          Import More
        </button>
      </div>
    );
  }

  // Error
  return (
    <div className="rounded-xl border border-down/30 bg-down-tint p-6">
      <div className="flex items-center gap-3 mb-3">
        <svg className="w-5 h-5 text-down" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
        <h3 className="text-lg font-medium text-ink">Import Failed</h3>
      </div>
      <p className="text-sm text-ink-dim mb-2">
        {(state as { status: "error"; message: string }).message}
      </p>
      <p className="text-xs text-ink-faint mb-4">
        Supported formats: Vanguard PDFs, IBKR CSVs, Vanguard CSVs, Canonical CSVs (see format guide below)
      </p>
      <button
        onClick={reset}
        className="px-5 py-2.5 rounded-lg border border-edge text-ink-dim text-sm hover:bg-raised transition-colors focus-ring"
      >
        Try Again
      </button>
    </div>
  );
}
