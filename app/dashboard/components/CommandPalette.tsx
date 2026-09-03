"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

// Cmd+K is now a global ticker-jump (IA Phase 2). Symbol-first by design;
// company-name search still works because /api/search?type=security ranks
// symbol-prefix matches above name matches. Reconsider broadening only if
// the user complains about a missed name search.
type SearchResult = {
  type: "security";
  id: number;
  title: string;     // symbol
  subtitle: string;  // name · type · sector
  href: string;      // /dashboard/security/[id]
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Cmd+K to toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}&type=security`
        );
        const data = await res.json();
        setResults(data.results ?? []);
        setSelectedIndex(0);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query]);

  const navigate = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router]
  );

  const handleKeyNav = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[selectedIndex]) {
        e.preventDefault();
        navigate(results[selectedIndex].href);
      }
    },
    [results, selectedIndex, navigate]
  );

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-[60] backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Palette */}
      {/* Inline backgroundColor mirrors the 790d317 fix: the parent backdrop has
         backdrop-blur-sm, which on iOS Safari can let the bg-canvas Tailwind
         class render translucent. Defense-in-depth via CSS var fallback. */}
      <div
        style={{ backgroundColor: "var(--canvas)" }}
        className="fixed top-[12%] md:top-[20%] left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] md:w-[560px] max-w-[90vw] z-[61] rounded-xl border border-edge bg-canvas shadow-2xl overflow-hidden"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-edge">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            className="text-ink-faint shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyNav}
            placeholder="Jump to ticker (AAPL, NVDA, ...)"
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint outline-none uppercase"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
          )}
          <kbd className="text-[10px] text-ink-faint font-mono bg-raised px-1.5 py-0.5 rounded border border-edge">
            esc
          </kbd>
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div className="max-h-[320px] overflow-y-auto py-1">
            {results.map((result, i) => (
              <button
                key={`security-${result.id}`}
                onClick={() => navigate(result.href)}
                // onMouseMove, not onMouseEnter: results re-render as the
                // debounced search resolves per keystroke, and browsers
                // synthesize a mouseenter/mouseover for a NEW element that
                // appears under an already-stationary pointer (hit-testing
                // recompute on layout change, not a real input event) — that
                // phantom event was silently stealing the keyboard/Enter
                // target away from the typed exact match onto whatever row
                // happened to sit under the resting cursor (QA:
                // cmdk--hover-steals-enter-target-expired-options-ranked-above-stock-regression-2).
                // mousemove only ever fires from genuine pointer movement, so
                // deliberate hovering still updates the selection as before.
                onMouseMove={() => setSelectedIndex(i)}
                className={`w-full text-left px-4 py-2.5 flex items-baseline gap-3 transition-colors ${
                  i === selectedIndex
                    ? "bg-raised"
                    : "hover:bg-raised/50"
                }`}
              >
                <div className="font-mono text-sm font-medium text-gold-ink shrink-0 w-16">
                  {result.title}
                </div>
                <div className="text-xs text-ink-faint truncate flex-1">
                  {result.subtitle}
                </div>
                {i === selectedIndex && (
                  <kbd className="text-[10px] text-ink-faint font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                    ↵
                  </kbd>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {query.trim() && !loading && results.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-ink-faint">
            No ticker matches &ldquo;{query}&rdquo;
          </div>
        )}

        {/* Hint when empty */}
        {!query.trim() && (
          <div className="px-4 py-4 text-xs text-ink-faint">
            Type a ticker symbol (or company name fragment) and press <kbd className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]">↵</kbd> to jump to its security detail page.
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Search trigger button for the header bar.
 */
export function SearchButton() {
  const [, setOpen] = useState(false);

  // This triggers the CommandPalette by simulating Cmd+K
  function handleClick() {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "k",
        metaKey: true,
        bubbles: true,
      })
    );
  }

  return (
    <button
      onClick={handleClick}
      className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-faint hover:text-ink-dim hover:bg-raised border border-transparent transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
      title="Search (Cmd+K)"
      aria-label="Open search"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      {/* Keyboard hint \u2014 meaningless on touch, hidden there */}
      <kbd className="hidden md:pointer-fine:inline text-[10px] font-mono">{"\u2318"}K</kbd>
    </button>
  );
}
