"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { tabs } from "./nav-tabs";

// Swipe-to-close threshold: how far the user must drag left before we
// commit the dismiss on touchend. 50px feels right — far enough to
// distinguish from accidental finger jitter, short enough to not require
// a full-arm swipe.
const SWIPE_CLOSE_THRESHOLD = 50;

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
  const [dragX, setDragX] = useState(0); // negative = finger pulled left from start
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
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

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    touchStartYRef.current = e.touches[0].clientY;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartXRef.current === null || touchStartYRef.current === null) return;
    const dx = e.touches[0].clientX - touchStartXRef.current;
    const dy = e.touches[0].clientY - touchStartYRef.current;
    // Treat as drawer-drag only if the gesture is mostly horizontal AND
    // moving leftward. Otherwise let it through as a normal scroll/tap.
    if (Math.abs(dx) <= Math.abs(dy)) return;
    if (dx >= 0) return;
    // Cap at -drawer-width (256px = w-64) so the user can't drag beyond
    // the closed position — past that point it'd just be wasted travel.
    setDragX(Math.max(dx, -256));
  }, []);

  const onTouchEnd = useCallback(() => {
    if (touchStartXRef.current !== null && dragX <= -SWIPE_CLOSE_THRESHOLD) {
      close();
    }
    setDragX(0);
    touchStartXRef.current = null;
    touchStartYRef.current = null;
  }, [dragX, close]);

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
        style={{
          backgroundColor: "var(--panel, #ffffff)",
          // While the user's finger is mid-drag, follow it directly with
          // no transition so the drawer feels physical. Inline transform
          // wins over the Tailwind translate-x-* class via specificity.
          // On touchend dragX resets to 0 → inline transform clears →
          // Tailwind class transition (300ms) snaps the drawer back, OR
          // close() flips Tailwind to `-translate-x-full` for the dismiss.
          ...(dragX < 0 && {
            transform: `translateX(${dragX}px)`,
            transition: "none",
          }),
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
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
