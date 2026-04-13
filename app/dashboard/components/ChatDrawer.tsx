"use client";

import { useState, useEffect, useCallback } from "react";
import { ChatInterface } from "./ChatInterface";

export function ChatDrawer() {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((v) => !v), []);

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

  return (
    <>
      {/* Toggle button */}
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          open
            ? "bg-gold/10 text-gold border border-gold/30"
            : "text-ink-faint hover:text-ink-dim hover:bg-raised border border-transparent"
        }`}
        title="Toggle chat (Cmd+J)"
        aria-label="Toggle chat assistant"
        aria-expanded={open}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        Chat
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black/30 z-40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Drawer panel */}
      <div
        className={`fixed top-0 electron:top-7 right-0 h-full electron:h-[calc(100%-1.75rem)] w-[480px] max-w-[90vw] z-50 bg-canvas border-l border-edge shadow-2xl transform transition-transform duration-300 ease-in-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-label="Chat assistant"
        aria-hidden={!open}
      >
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-2">
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
            <span className="text-sm font-medium text-ink">
              Portfolio Assistant
            </span>
          </div>
          <div className="flex items-center gap-2">
            <kbd className="text-[10px] text-ink-faint font-mono bg-raised px-1.5 py-0.5 rounded border border-edge">
              {"\u2318"}J
            </kbd>
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
        <div className="h-[calc(100%-49px)]">
          <ChatInterface />
        </div>
      </div>
    </>
  );
}
