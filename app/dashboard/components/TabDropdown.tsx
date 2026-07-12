"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubView, Tab } from "./nav-tabs";

interface Props {
  tab: Tab;
  isActive: boolean;
}

function subviewMatches(sv: SubView, searchParams: URLSearchParams): boolean {
  if (!sv.matchParam) return false;
  const current = searchParams.get(sv.matchParam.key);
  return current === sv.matchParam.value;
}

export function TabDropdown({ tab, isActive }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const subviews = tab.subviews ?? [];

  const close = useCallback(() => {
    setOpen(false);
    setFocusIndex(0);
  }, []);

  // Recompute menu position when open; also on scroll/resize so it stays glued to the tab.
  useEffect(() => {
    if (!open) return;

    function reposition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom + 2, left: rect.left + 8 });
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function onClickOutside(e: MouseEvent) {
      const inContainer = containerRef.current?.contains(e.target as Node);
      const inMenu = menuRef.current?.contains(e.target as Node);
      if (!inContainer && !inMenu) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusIndex((i) => (i + 1) % subviews.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIndex((i) => (i - 1 + subviews.length) % subviews.length);
      } else if (e.key === "Home") {
        e.preventDefault();
        setFocusIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setFocusIndex(subviews.length - 1);
      } else if (e.key === "Enter") {
        const item = itemRefs.current[focusIndex];
        if (item) {
          e.preventDefault();
          router.push(item.getAttribute("href") ?? tab.href);
          close();
        }
      }
    }

    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, subviews.length, focusIndex, router, tab.href]);

  useEffect(() => {
    if (open) itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  // Close when route changes (user clicked a subview, menu should dismiss)
  useEffect(() => {
    close();
  }, [pathname, searchParams, close]);

  function toggleOpen(e: React.MouseEvent | React.KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    setOpen((prev) => !prev);
    setFocusIndex(0);
  }

  function onTabKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setFocusIndex(0);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center">
        <Link
          href={tab.href}
          role="tab"
          aria-selected={isActive}
          aria-haspopup="menu"
          aria-expanded={open}
          tabIndex={isActive ? 0 : -1}
          onKeyDown={onTabKeyDown}
          className={`relative pl-4 pr-1.5 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
            isActive ? "text-gold" : "text-ink-faint hover:text-ink-dim"
          }`}
        >
          {tab.name}
          {isActive && (
            <span className="absolute bottom-0 left-2 right-1.5 h-0.5 bg-gold rounded-full" />
          )}
        </Link>
        <button
          type="button"
          onClick={toggleOpen}
          aria-label={`${tab.name} sub-views`}
          aria-haspopup="menu"
          aria-expanded={open}
          className={`relative pr-3 pl-0.5 py-2.5 text-xs transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 pointer-coarse:after:content-[''] ${
            open ? "text-gold" : isActive ? "text-gold" : "text-ink-faint hover:text-ink-dim"
          }`}
        >
          <span aria-hidden style={{ letterSpacing: "0.1em" }}>•••</span>
          {isActive && (
            <span className="absolute bottom-0 left-0.5 right-3 h-0.5 bg-gold rounded-full" />
          )}
        </button>
      </div>

      {open && menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${tab.name} sub-views`}
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            backgroundColor: "var(--panel)",
          }}
          className="z-50 min-w-[180px] rounded-lg border border-edge-strong bg-panel shadow-xl py-1"
        >
          {subviews.map((sv, i) => {
            const active = subviewMatches(sv, searchParams);
            return (
              <Link
                key={sv.href}
                href={sv.href}
                role="menuitem"
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                tabIndex={-1}
                className={`flex items-center justify-between px-3 py-1.5 pointer-coarse:py-2.5 text-sm transition-colors ${
                  active ? "text-gold" : "text-ink-dim hover:text-ink hover:bg-raised"
                } focus:bg-raised focus:outline-none`}
              >
                <span>{sv.name}</span>
                {active && <span aria-hidden className="text-xs">✓</span>}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
