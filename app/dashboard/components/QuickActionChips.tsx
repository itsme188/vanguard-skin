"use client";

import type { QuickAction } from "@/lib/chat/quick-actions";
import { ScrollFade } from "./ScrollFade";

interface Props {
  actions: QuickAction[];
  onSelect: (prompt: string) => void;
}

export function QuickActionChips({ actions, onSelect }: Props) {
  if (actions.length === 0) return null;
  return (
    <ScrollFade className="-mx-1 px-1" scrollerClassName="scrollbar-none">
      <div className="flex gap-2 pb-2">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => onSelect(action.prompt)}
            className="shrink-0 px-3 py-2 rounded-xl border border-edge bg-panel text-sm text-ink-dim hover:text-ink hover:border-edge-strong transition-colors"
          >
            {action.label}
          </button>
        ))}
      </div>
    </ScrollFade>
  );
}
