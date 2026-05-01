"use client";

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { ChatInterface } from "./ChatInterface";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useIsLargeDesktop } from "@/lib/hooks/useIsLargeDesktop";

// Three layout modes:
//   - mobile (<768px): full-screen overlay, slide-up. Opens via toggle-mobile-chat
//     event (mobile bottom-nav Chat slot, Cmd+J shortcut).
//   - desktop drawer (768–1279px): right-side drawer with backdrop + Cmd+J toggle.
//   - large desktop (≥1280px): persistent right-rail. Always-visible. Cmd+J
//     focuses the chat input via the focus-chat-input event. The dashboard
//     layout reserves matching `xl:pr-[480px]` so content doesn't underlap.
const RAIL_WIDTH = 480;

export function ChatDrawer() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const isLargeDesktop = useIsLargeDesktop();
  const pathname = usePathname();

  // At xl, the rail is conceptually always open — we don't actually flip the
  // open state, but the panel renders with translate-x-0 unconditionally.
  const railVisible = isLargeDesktop || open;

  const toggle = useCallback(() => {
    if (isLargeDesktop) {
      // Rail is already visible — focus input instead of toggling.
      window.dispatchEvent(new CustomEvent("focus-chat-input"));
      return;
    }
    setOpen((v) => !v);
  }, [isLargeDesktop]);

  // Broadcast open-state for the header ChatToggleButton to mirror.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("chat-state-change", { detail: { open: railVisible } }),
    );
  }, [railVisible]);

  // Cmd+J shortcut.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && open && !isLargeDesktop) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, isLargeDesktop, toggle]);

  // toggle-mobile-chat from MobileBottomNav + ChatToggleButton.
  useEffect(() => {
    function handleToggle() {
      toggle();
    }
    window.addEventListener("toggle-mobile-chat", handleToggle);
    return () => window.removeEventListener("toggle-mobile-chat", handleToggle);
  }, [toggle]);

  // Compute the panel className per layout mode.
  const panelClass = isMobile
    ? `inset-0 ${open ? "translate-y-0" : "translate-y-full"}`
    : isLargeDesktop
      ? `top-0 electron:top-7 right-0 h-full electron:h-[calc(100%-1.75rem)] border-l border-edge translate-x-0`
      : `top-0 electron:top-7 right-0 h-full electron:h-[calc(100%-1.75rem)] border-l border-edge shadow-2xl ${
          open ? "translate-x-0" : "translate-x-full"
        }`;

  return (
    <>
      {/* Backdrop — only when drawer is open (not on xl rail, not on mobile). */}
      {open && !isMobile && !isLargeDesktop && (
        <div
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Chat panel */}
      <div
        className={`fixed z-50 bg-canvas transform transition-transform duration-300 ease-in-out ${panelClass}`}
        style={!isMobile ? { width: `${RAIL_WIDTH}px`, maxWidth: "90vw" } : undefined}
        role={isLargeDesktop ? "complementary" : "dialog"}
        aria-label="Chat assistant"
        aria-hidden={!railVisible}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-2">
            {isMobile ? (
              <button
                onClick={() => setOpen(false)}
                className="text-ink-dim hover:text-ink transition-colors p-1 -ml-1 rounded-md"
                aria-label="Close chat"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            ) : (
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="text-gold"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            )}
            <span className="text-sm font-medium text-ink">
              Portfolio Assistant
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isMobile && (
              <kbd className="text-[10px] text-ink-faint font-mono bg-raised px-1.5 py-0.5 rounded border border-edge">
                {"⌘"}J
              </kbd>
            )}
            {/* Close button — hidden on the persistent rail. */}
            {!isLargeDesktop && (
              <button
                onClick={() => setOpen(false)}
                className="text-ink-faint hover:text-ink transition-colors p-1 rounded-md hover:bg-raised"
                aria-label="Close chat"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Chat content — always mounted to preserve conversation */}
        <div className={isMobile ? "h-[calc(100dvh-49px)] pb-safe" : "h-[calc(100%-49px)]"}>
          <ChatInterface pathname={pathname} />
        </div>
      </div>
    </>
  );
}
