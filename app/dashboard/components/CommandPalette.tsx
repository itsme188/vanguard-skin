"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface SearchResult {
  type: "security" | "note" | "transaction";
  id: number;
  title: string;
  subtitle: string;
  href: string;
}

const TYPE_ICONS: Record<string, string> = {
  security: "\u{1F4C8}", // chart icon
  note: "\u{1F4DD}",     // memo icon
  transaction: "\u{1F4B1}", // currency icon
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
          `/api/search?q=${encodeURIComponent(query.trim())}`
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
      <div className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[560px] max-w-[90vw] z-[61] rounded-xl border border-edge bg-canvas shadow-2xl overflow-hidden">
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
            placeholder="Search securities, notes, transactions..."
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint outline-none"
            autoComplete="off"
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
                key={`${result.type}-${result.id}`}
                onClick={() => navigate(result.href)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                  i === selectedIndex
                    ? "bg-raised"
                    : "hover:bg-raised/50"
                }`}
              >
                <span className="text-sm mt-0.5 shrink-0">
                  {TYPE_ICONS[result.type] ?? ""}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink truncate">
                    {result.title}
                  </div>
                  <div className="text-xs text-ink-faint truncate">
                    {result.subtitle}
                  </div>
                </div>
                <span className="text-[10px] text-ink-faint bg-muted px-1.5 py-0.5 rounded shrink-0 mt-0.5">
                  {result.type}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {query.trim() && !loading && results.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-ink-faint">
            No results for &ldquo;{query}&rdquo;
          </div>
        )}

        {/* Hint when empty */}
        {!query.trim() && (
          <div className="px-4 py-4 text-xs text-ink-faint">
            Type to search securities by symbol or name, notes by content, or transactions by symbol.
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
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-faint hover:text-ink-dim hover:bg-raised border border-transparent transition-colors"
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
      <kbd className="text-[10px] font-mono">{"\u2318"}K</kbd>
    </button>
  );
}
