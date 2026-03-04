export default function ReconciliationPage() {
  return (
    <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
      <div className="text-ink-faint text-3xl mb-3">&Delta;</div>
      <h2 className="text-lg font-medium text-ink mb-2">Reconciliation</h2>
      <p className="text-ink-dim text-sm max-w-md mx-auto">
        Compare computed portfolio values against your actual account statements
        to find discrepancies.
      </p>
    </div>
  );
}
