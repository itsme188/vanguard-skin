import Link from "next/link";
import { OPTIONS } from "./options";
import "./options.css";

export const dynamic = "force-static";

/**
 * Landing page for the Today design comparison. Four cohesive
 * directions, each linkable as a full-page preview. Use this to pick
 * a direction holistically before applying any changes to production.
 */
export default function TodayOptionsLanding() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <div className="max-w-[1200px] mx-auto px-6 py-10">
        <header className="mb-10">
          <p className="text-[11px] uppercase tracking-widest text-ink-faint mb-2">
            Design preview
          </p>
          <h1 className="font-serif text-4xl text-gold tracking-tight">
            Today — four directions
          </h1>
          <p className="text-[15px] text-ink-dim mt-3 max-w-2xl leading-relaxed">
            Four cohesive design directions for the Today page. Each one is a
            complete rendering with the same mock data, so the only thing that
            differs is the visual treatment. Click any option to view it
            full-page; flip themes inside each to see light + dark; jump
            between options via the sticky chrome at the top.
          </p>
          <p className="text-[13px] text-ink-faint mt-2">
            Pick a direction. Then we apply it cleanly to the production Today
            page and let the rest of the app inherit from it.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {OPTIONS.map((o) => (
            <Link
              key={o.id}
              href={`/design-preview/today-options/${o.id}`}
              className="group rounded-xl border border-edge bg-panel p-6 hover:border-edge-strong transition-colors"
            >
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="font-serif text-2xl text-ink tracking-tight">
                  {o.name}
                </h2>
                <span className="text-[11px] uppercase tracking-widest text-ink-faint group-hover:text-gold">
                  View →
                </span>
              </div>
              <p className="text-[14px] text-ink-dim italic mb-4">{o.tagline}</p>
              <p className="text-[13px] text-ink-faint leading-relaxed mb-5">
                {o.description}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {o.swatches.map((s) => (
                  <div key={s.label} className="flex items-center gap-1.5">
                    <span
                      className="w-5 h-5 rounded-full border border-edge"
                      style={{ background: s.hex }}
                    />
                    <span className="text-[10px] uppercase tracking-wide text-ink-faint font-mono">
                      {s.label}
                    </span>
                  </div>
                ))}
              </div>
            </Link>
          ))}
        </div>

        <p className="text-[12px] text-ink-faint mt-10 italic">
          Mock data only. None of this affects the live Today page until we
          pick a direction and apply it.
        </p>
      </div>
    </div>
  );
}
