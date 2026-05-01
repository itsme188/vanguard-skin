"use client";

import { useEffect, useState } from "react";

/**
 * Desktop header button that toggles the chat drawer. The panel itself lives in
 * <ChatDrawer /> at layout root so the mobile full-screen overlay works; this
 * button lives in the header so it's actually clickable on desktop. They
 * communicate via the shared `toggle-mobile-chat` DOM event (same channel
 * MobileBottomNav uses — one toggle source of truth).
 *
 * Mobile path: hidden via md:flex (mobile uses MobileBottomNav's chat icon).
 */
export function ChatToggleButton() {
  const [open, setOpen] = useState(false);

  // Reflect open state so the button shows the active style when the drawer is
  // open. ChatDrawer dispatches `chat-state-change` whenever its internal
  // `open` state flips.
  useEffect(() => {
    function handleChange(e: Event) {
      const detail = (e as CustomEvent<{ open: boolean }>).detail;
      setOpen(!!detail?.open);
    }
    window.addEventListener("chat-state-change", handleChange);
    return () => window.removeEventListener("chat-state-change", handleChange);
  }, []);

  function toggle() {
    window.dispatchEvent(new CustomEvent("toggle-mobile-chat"));
  }

  return (
    <button
      onClick={toggle}
      // Hidden on xl — the chat right rail is always-visible there (no toggle needed).
      className={`hidden md:flex xl:hidden items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
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
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      Chat
    </button>
  );
}
