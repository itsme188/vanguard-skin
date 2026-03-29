import { SkeletonTable } from "../components/Skeletons";

export default function HoldingsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="bg-muted animate-pulse rounded-lg h-6 w-48" />
        <div className="bg-muted animate-pulse rounded-lg h-3 w-72" />
      </div>
      <SkeletonTable rows={10} />
    </div>
  );
}
