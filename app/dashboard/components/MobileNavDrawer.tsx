"use client";

import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { tabs } from "./nav-tabs";

/**
 * Hamburger + slide-in drawer for mobile navigation.
 *
 * Rendering split: the hamburger BUTTON stays inline (in the header) so it
 * lays out next to the title, but the BACKDROP + DRAWER PANEL portal to
 * document.body. Reason: <header> has `bg-canvas/80 backdrop-blur-xl`
 * which creates a stacking context — descendants rendering inside that
 * context were showing translucent on iOS Safari with page content
 * bleeding through. Portaling escapes the stacking context entirely,
 * matching how ChatDrawer / WelcomeOverlay are rendered at root level.
 */
export function MobileNavDrawer() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    close();
  }, [pathname, close]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, close]);

  const overlay = (
    <>
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-[60] backdrop-blur-sm md:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}
      <nav
        className={`fixed top-0 left-0 h-full w-64 z-[70] border-r border-edge shadow-2xl transform transition-transform duration-300 ease-in-out md:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ backgroundColor: "var(--panel, #ffffff)" }}
        role="dialog"
        aria-label="Navigation menu"
        aria-hidden={!open}
      >
        <div
          className="flex items-center justify-between px-4 py-4 border-b border-edge"
          style={{ backgroundColor: "var(--raised, #f4f3ea)" }}
        >
          <span className="text-lg text-gold tracking-tight font-medium">
            Portfolio Desk
          </span>
          <button
            onClick={close}
            className="text-ink-faint hover:text-ink transition-colors p-1 rounded-md hover:bg-raised"
            aria-label="Close navigation"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="py-2">
          {tabs.map((tab) => {
            const isActive =
              tab.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(tab.href);

            return (
              <Link
                key={tab.href}
                href={tab.href}
                onClick={close}
                className={`flex items-center px-4 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "text-gold bg-gold/5 border-l-2 border-gold"
                    : "text-ink-dim hover:text-ink hover:bg-raised/50 border-l-2 border-transparent"
                }`}
              >
                {tab.name}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="md:hidden p-1.5 -ml-1 rounded-md text-ink-faint hover:text-ink transition-colors"
        aria-label="Open navigation menu"
        aria-expanded={open}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {mounted && createPortal(overlay, document.body)}
    </>
  );
}
