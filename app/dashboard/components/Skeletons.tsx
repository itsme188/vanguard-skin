const BAR_HEIGHTS = [45, 65, 35, 80, 55, 70, 40, 90, 60, 50, 75, 85];

export function SkeletonPulse({ className = "" }: { className?: string }) {
  return (
    <div className={`bg-muted animate-pulse rounded-lg ${className}`} />
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5 space-y-3">
      <SkeletonPulse className="h-3 w-24" />
      <SkeletonPulse className="h-8 w-32" />
      <SkeletonPulse className="h-3 w-20" />
    </div>
  );
}

export function SkeletonChart() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-5">
      <SkeletonPulse className="h-3 w-32 mb-4" />
      <div className="h-[280px] flex items-end gap-1 px-4">
        {BAR_HEIGHTS.map((h, i) => (
          <div
            key={i}
            className="flex-1 bg-muted animate-pulse rounded-t-sm"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-edge overflow-hidden">
      <div className="border-b border-edge bg-panel px-4 py-2.5 flex gap-4">
        {Array.from({ length: 5 }, (_, i) => (
          <SkeletonPulse key={i} className="h-3 w-16" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="border-b border-edge last:border-0 px-4 py-3 flex gap-4">
          {Array.from({ length: 5 }, (_, j) => (
            <SkeletonPulse key={j} className="h-3 w-16" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonMetrics() {
  return (
    <div className="flex items-baseline gap-6">
      <div className="space-y-2">
        <SkeletonPulse className="h-2.5 w-20" />
        <SkeletonPulse className="h-10 w-40" />
      </div>
      <SkeletonPulse className="h-6 w-24" />
      <SkeletonPulse className="h-5 w-16 rounded" />
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <SkeletonMetrics />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonChart />
    </div>
  );
}

/* ── Account selector + chart + table ── */
export function AccountsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <SkeletonPulse className="h-9 w-32 rounded-lg" />
        <SkeletonPulse className="h-9 w-32 rounded-lg" />
        <SkeletonPulse className="h-9 w-40 rounded-lg" />
      </div>
      <SkeletonChart />
      <SkeletonTable rows={6} />
      <SkeletonTable rows={4} />
    </div>
  );
}

/* ── Header + summary cards + 2 tables ── */
export function TaxLotsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <SkeletonPulse className="h-6 w-48" />
          <SkeletonPulse className="h-3 w-72" />
        </div>
        <SkeletonPulse className="h-9 w-28 rounded-lg" />
      </div>
      <div className="flex gap-2">
        <SkeletonPulse className="h-8 w-16 rounded-full" />
        <SkeletonPulse className="h-8 w-16 rounded-full" />
        <SkeletonPulse className="h-8 w-16 rounded-full" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <SkeletonTable rows={6} />
    </div>
  );
}

/* ── Mode toggle + dimension pills + pie chart + table ── */
export function AnalysisSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <SkeletonPulse className="h-9 w-48 rounded-lg" />
        <SkeletonPulse className="h-8 w-24 rounded-full" />
        <SkeletonPulse className="h-8 w-20 rounded-full" />
        <SkeletonPulse className="h-8 w-16 rounded-full" />
      </div>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonPulse key={i} className="h-8 w-20 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-edge bg-panel p-5 flex items-center justify-center">
          <SkeletonPulse className="h-64 w-64 rounded-full" />
        </div>
        <SkeletonTable rows={8} />
      </div>
    </div>
  );
}

/* ── Drop zone + import history table ── */
export function ImportSkeleton() {
  return (
    <div className="space-y-8">
      <div className="rounded-xl border-2 border-dashed border-edge p-12 flex flex-col items-center justify-center">
        <SkeletonPulse className="h-12 w-12 rounded-full mb-4" />
        <SkeletonPulse className="h-4 w-48 mb-2" />
        <SkeletonPulse className="h-3 w-32" />
      </div>
      <div className="space-y-3">
        <SkeletonPulse className="h-5 w-32" />
        <SkeletonTable rows={4} />
      </div>
    </div>
  );
}

/* ── Title + form area + checkpoints table ── */
export function ReconciliationSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <SkeletonPulse className="h-6 w-44" />
          <SkeletonPulse className="h-3 w-64" />
        </div>
        <SkeletonPulse className="h-9 w-36 rounded-lg" />
      </div>
      <SkeletonTable rows={3} />
    </div>
  );
}

/* ── Filter pills + search + note cards ── */
export function NotesSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        <SkeletonPulse className="h-8 w-14 rounded-full" />
        <SkeletonPulse className="h-8 w-20 rounded-full" />
        <SkeletonPulse className="h-8 w-24 rounded-full" />
        <SkeletonPulse className="h-8 w-28 rounded-full" />
      </div>
      <SkeletonPulse className="h-10 w-full rounded-lg" />
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <div
            key={i}
            className="rounded-xl border border-edge bg-panel p-5 space-y-3"
          >
            <div className="flex gap-2">
              <SkeletonPulse className="h-5 w-16 rounded" />
              <SkeletonPulse className="h-5 w-20 rounded" />
            </div>
            <SkeletonPulse className="h-3 w-full" />
            <SkeletonPulse className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Welcome area + input bar ── */
export function ChatSkeleton() {
  return (
    <div className="flex flex-col h-[calc(100dvh-12rem)]">
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-4">
          <SkeletonPulse className="h-10 w-32 mx-auto" />
          <SkeletonPulse className="h-4 w-56 mx-auto" />
          <div className="flex gap-2 justify-center mt-4">
            <SkeletonPulse className="h-8 w-28 rounded-full" />
            <SkeletonPulse className="h-8 w-24 rounded-full" />
            <SkeletonPulse className="h-8 w-20 rounded-full" />
          </div>
        </div>
      </div>
      <div className="border-t border-edge p-4">
        <SkeletonPulse className="h-12 w-full rounded-lg" />
      </div>
    </div>
  );
}
