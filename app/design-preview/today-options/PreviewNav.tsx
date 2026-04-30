"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { OPTIONS, type OptionId } from "./options";

interface PreviewNavProps {
  current: OptionId;
}

/**
 * Sticky chrome at the top of each preview page. Lets the user flip
 * between the four options without bouncing back to the landing page.
 * Also exposes a theme toggle so each option can be evaluated in both
 * light and dark — the toggle uses the same vgs:theme localStorage key
 * the production app uses, so the choice persists.
 */
export function PreviewNav({ current }: PreviewNavProps) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const stored = window.localStorage.getItem("vgs:theme") as "light" | "dark" | null;
    if (stored) {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    }
  }, []);

  function flip() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    window.localStorage.setItem("vgs:theme", next);
    document.documentElement.dataset.theme = next;
  }

  return (
    <div className="sticky top-0 z-10 -mx-4 md:-mx-6 px-4 md:px-6 py-3 border-b border-edge bg-canvas/95 backdrop-blur">
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href="/design-preview/today-options"
          className="text-[11px] uppercase tracking-widest text-ink-faint hover:text-gold border border-edge rounded-full px-3 py-1"
        >
          ← Compare
        </Link>
        <div className="flex items-center gap-1 ml-auto">
          {OPTIONS.map((o) => (
            <Link
              key={o.id}
              href={`/design-preview/today-options/${o.id}`}
              className={`text-[12px] font-medium tracking-wide rounded-full px-3 py-1 transition-colors ${
                o.id === current
                  ? "bg-gold text-panel"
                  : "border border-edge text-ink-dim hover:text-ink hover:border-edge-strong"
              }`}
            >
              {o.name}
            </Link>
          ))}
          <button
            type="button"
            onClick={flip}
            className="text-[12px] font-medium rounded-full px-3 py-1 border border-edge text-ink-dim hover:text-ink hover:border-edge-strong ml-2"
          >
            {theme === "light" ? "Dark" : "Light"}
          </button>
        </div>
      </div>
    </div>
  );
}
