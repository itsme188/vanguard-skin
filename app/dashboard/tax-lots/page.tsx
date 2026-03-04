export default function TaxLotsPage() {
  return (
    <div className="rounded-xl border border-dashed border-edge bg-panel/50 p-12 text-center">
      <div className="text-ink-faint text-3xl mb-3">FIFO</div>
      <h2 className="text-lg font-medium text-ink mb-2">Tax Lots</h2>
      <p className="text-ink-dim text-sm max-w-md mx-auto">
        Tax lot tracking with FIFO cost basis allocation will be available after
        the compute engine is implemented.
      </p>
    </div>
  );
}
