"use client";

/**
 * Full-width chat launcher for the mobile Today view. Dispatches "open-chat"
 * (handled by ChatDrawer), which always OPENS the chat overlay/rail and
 * focuses the composer — unlike "toggle-mobile-chat" (used by the mobile
 * bottom-nav Chat button and the header ChatToggleButton), this never closes
 * an already-open desktop rail on a second click (deep-QA finding, 2026-08-20).
 */
export function OpenChatButton() {
  function openChat() {
    window.dispatchEvent(new CustomEvent("open-chat"));
  }

  return (
    <button
      onClick={openChat}
      className="w-full rounded-xl border border-gold/30 bg-gold/5 hover:bg-gold/10 transition-colors py-3 px-5 flex items-center gap-3 focus-ring"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="text-gold"
        aria-hidden="true"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      <span className="text-[13px] font-medium text-gold-ink flex-1 text-left">
        Ask Claude about your portfolio
      </span>
      <span className="text-[11px] font-mono text-gold/70">Cmd+J</span>
    </button>
  );
}
