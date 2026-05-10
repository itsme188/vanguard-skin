export function MetricCard({
  label,
  value,
  description,
  color,
}: {
  label: string;
  value: string;
  description: string;
  color: string;
}) {
  return (
    <div className="bg-raised/50 rounded-lg p-3">
      <p className="text-xs text-ink-faint uppercase">{label}</p>
      <p className={`text-xl font-mono font-medium mt-1 ${color}`}>{value}</p>
      <p className="text-xs text-ink-faint mt-1">{description}</p>
    </div>
  );
}
