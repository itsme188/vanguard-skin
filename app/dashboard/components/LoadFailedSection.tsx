/**
 * The shell a card shows when its own load failed.
 *
 * A failed load is not an empty result. `EmptySection` says "empty" in its
 * badge and names the data the section is waiting for; putting a failure in
 * that shell tells the reader there is nothing to show, which is false. This
 * shell has the same footprint, says the load failed, and carries the reason
 * in plain words (the caller builds it with `readMutationResult` /
 * `networkFailureMessage` from lib/ui/mutation-result.ts).
 */
interface LoadFailedSectionProps {
  title: string;
  /** One plain sentence: what could not be loaded and why. */
  message: string;
  /** What the reader can do about it. */
  hint?: string;
}

export function LoadFailedSection({ title, message, hint }: LoadFailedSectionProps) {
  return (
    <section className="bg-panel rounded-xl p-4 sm:p-5 card-elev">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm font-medium text-ink">{title}</h3>
        <span className="text-[11px] uppercase tracking-widest text-ink-dim">not loaded</span>
      </div>
      <p role="alert" className="text-sm text-ink">
        {message}
      </p>
      {hint && <p className="text-xs text-ink-dim mt-2">{hint}</p>}
    </section>
  );
}
