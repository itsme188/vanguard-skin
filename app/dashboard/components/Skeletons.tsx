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
