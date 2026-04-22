"use client";

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { ChatInterface } from "./ChatInterface";
import { useIsMobile } from "@/lib/hooks/useIsMobile";

export function ChatDrawer() {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const pathname = usePathname();

  const toggle = useCallback(() => setOpen((v) => !v), []);

  // Broadcast open-state changes so the header <ChatToggleButton /> can reflect
  // the active styling. Same channel (`chat-state-change`) can be consumed by
  // any other surface that wants to mirror the drawer state.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("chat-state-change", { detail: { open } }),
    );
  }, [open]);

  // Keyboard shortcut: Cmd+J to toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "j") {
        e.preventDefault();
        toggle();
      }
      // Escape to close
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, toggle]);

  // Listen for toggle-mobile-chat from MobileBottomNav + ChatToggleButton
  useEffect(() => {
    function handleToggle() {
      toggle();
    }
    window.addEventListener("toggle-mobile-chat", handleToggle);
    return () => window.removeEventListener("toggle-mobile-chat", handleToggle);
  }, [toggle]);

  return (
    <>
      {/* Backdrop — desktop only */}
      {open && !isMobile && (
        <div
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Chat panel — full-screen on mobile, side drawer on desktop */}
      <div
        className={`fixed z-50 bg-canvas transform transition-transform duration-300 ease-in-out ${
          isMobile
            ? `inset-0 ${open ? "translate-y-0" : "translate-y-full"}`
            : `top-0 electron:top-7 right-0 h-full electron:h-[calc(100%-1.75rem)] w-[480px] max-w-[90vw] border-l border-edge shadow-2xl ${
                open ? "translate-x-0" : "translate-x-full"
              }`
        }`}
        role="dialog"
        aria-label="Chat assistant"
        aria-hidden={!open}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-2">
            {isMobile ? (
              /* Back arrow on mobile */
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
                {"\u2318"}J
              </kbd>
            )}
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
