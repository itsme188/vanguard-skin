import {
  SkeletonPulse,
  SkeletonChart,
  SkeletonTable,
} from "../../components/Skeletons";

export default function SecurityDetailLoading() {
  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <SkeletonPulse className="h-4 w-40" />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <SkeletonPulse className="h-8 w-20" />
            <SkeletonPulse className="h-6 w-40" />
          </div>
          <SkeletonPulse className="h-4 w-48" />
        </div>
        <div className="space-y-1 text-right">
          <SkeletonPulse className="h-8 w-24 ml-auto" />
          <SkeletonPulse className="h-4 w-32 ml-auto" />
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        <SkeletonPulse className="h-8 w-24" />
        <SkeletonPulse className="h-8 w-28" />
      </div>

      {/* Chart */}
      <SkeletonChart />

      {/* Positions */}
      <SkeletonTable rows={3} />

      {/* Tax Lots */}
      <SkeletonTable rows={4} />

      {/* Transactions */}
      <SkeletonTable rows={5} />
    </div>
  );
}
