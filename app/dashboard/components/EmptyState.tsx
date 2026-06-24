import Link from "next/link";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: { label: string; href: string };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-edge p-12 text-center">
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4 text-ink-faint">
        {icon}
      </div>
      <h3 className="text-base font-medium text-ink mb-1">{title}</h3>
      <p className="text-sm text-ink-dim max-w-xs">{description}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-4 px-4 py-2 rounded-lg bg-gold text-canvas text-sm font-medium hover:brightness-110 transition-[filter,scale] active:scale-[0.96] focus-ring"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
