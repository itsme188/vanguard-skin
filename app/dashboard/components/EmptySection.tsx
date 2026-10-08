/**
 * Empty-state shell for Analysis sections that previously returned null.
 *
 * Replaces the silent-null pattern flagged in the Phase 5 audit
 * (we-never-really-finished-zesty-map.md): when 8 sections silently vanish
 * because their prerequisite data is missing, the page looks broken rather
 * than incomplete. EmptySection renders the section title with a quiet
 * "why is this empty" sentence so the user can tell intent from gap.
 *
 * Use sparingly — sections still skip rendering entirely when their data
 * dependencies are obviously absent (e.g. when no option-eligible accounts
 * exist at all). EmptySection is for the in-between case where the section
 * is *expected* but data is thin.
 */

import type { ReactNode } from "react";

interface EmptySectionProps {
  title: string;
  /** A sentence, or a node (a link, a privacy component) inside one. */
  reason: ReactNode;
  /** Same; only a plain-text hint also becomes the "empty" badge's tooltip. */
  hint?: ReactNode;
}

export function EmptySection({ title, reason, hint }: EmptySectionProps) {
  return (
    <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <span
          className="text-[11px] uppercase tracking-widest text-ink-faint cursor-help"
          title={typeof hint === "string" ? hint : "This section needs more data to render."}
        >
          empty ⓘ
        </span>
      </div>
      <p className="text-sm text-ink-faint">{reason}</p>
      {hint && (
        <p className="text-xs text-ink-faint mt-2 italic">{hint}</p>
      )}
    </section>
  );
}
