"use client";

import { useState, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { ChatInterface } from "./ChatInterface";
import { useIsMobile } from "@/lib/hooks/useIsMobile";
import { useIsLargeDesktop } from "@/lib/hooks/useIsLargeDesktop";
import { chatPanelWidthPx } from "@/lib/chat/rail-layout";

// Three layout modes:
//   - mobile (<768px): full-screen overlay, slide-up. Opens via toggle-mobile-chat
//     event (mobile bottom-nav Chat slot, Cmd+J shortcut).
//   - desktop drawer (768–1279px): right-side drawer with backdrop + Cmd+J toggle.
//   - large desktop (≥1280px): persistent right-rail. Toggleable between
//     "open" (480px reserved on the right) and "collapsed" (rail slides
//     off-screen, layout reservation drops to 0). Persisted in
//     localStorage["vgs:chatRail"] + mirrored to <html data-chat-rail="..."> by
//     the anti-FOUC script in app/layout.tsx, so first paint matches the
//     user's last choice. Cmd+J expands when collapsed; focuses input when open.
const COLLAPSE_STORAGE_KEY = "vgs:chatRail";
// Expanded = the wider reading width (U2b), orthogonal to collapsed. Persisted
// separately + mirrored to <html data-chat-expanded>. Applies to both the
// large-desktop rail and the 768–1279px drawer (not mobile — already full-screen).
const EXPAND_STORAGE_KEY = "vgs:chatExpanded";

export function ChatDrawer() {
  const [open, setOpen] = useState(false);
  // collapsed is meaningful only on large desktop. Read by the panel translate
  // and the header CSS attribute. Default to whatever the FOUC script wrote
  // (read on first client mount to avoid hydration mismatch).
  const [collapsed, setCollapsed] = useState(false);
  // expanded = wider panel for reading long answers. Default matches the FOUC
  // script (data-chat-expanded), synced to React state on first mount below.
  const [expanded, setExpanded] = useState(false);
  const isMobile = useIsMobile();
  const isLargeDesktop = useIsLargeDesktop();
  const pathname = usePathname();

  // Read collapse state once on mount. The anti-FOUC script in app/layout.tsx
  // already wrote the data attribute, so the first paint is correct — this
  // just syncs React state for the toggle controls.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      setCollapsed(stored === "collapsed");
      setExpanded(localStorage.getItem(EXPAND_STORAGE_KEY) === "true");
    } catch {
      // localStorage unavailable (private browsing) — stay in default open state
    }
  }, []);

  // Persist expanded + mirror to data-chat-expanded so globals.css widens the
  // layout reservation (--chat-rail-width) and first paint matches via the
  // anti-FOUC script in app/layout.tsx.
  useEffect(() => {
    try {
      localStorage.setItem(EXPAND_STORAGE_KEY, expanded ? "true" : "false");
      document.documentElement.setAttribute(
        "data-chat-expanded",
        expanded ? "true" : "false",
      );
    } catch {
      // ignored — see above
    }
  }, [expanded]);

  // Persist collapse state + sync the data attribute when it flips. The
  // attribute drives the layout reservation (chat-rail-reserve) and the
  // EarningsHub responsive override in globals.css.
  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSE_STORAGE_KEY,
        collapsed ? "collapsed" : "open",
      );
      document.documentElement.setAttribute(
        "data-chat-rail",
        collapsed ? "collapsed" : "open",
      );
    } catch {
      // ignored — see above
    }
  }, [collapsed]);

  // At xl, the rail is conceptually always available — visible when the user
  // hasn't collapsed it. The panel slides off-screen when collapsed.
  const railVisible = isLargeDesktop ? !collapsed : open;

  const toggle = useCallback(() => {
    if (isLargeDesktop) {
      // On large desktop, the toggle flips collapsed state. When expanding,
      // also focus the chat input so the user can start typing immediately.
      setCollapsed((v) => {
        const next = !v;
        if (!next) {
          // Defer focus until the panel has finished sliding back in
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("focus-chat-input"));
          }, 220);
        }
        return next;
      });
      return;
    }
    setOpen((v) => !v);
  }, [isLargeDesktop]);

  // open-chat: an OPEN-ONLY entry point (never closes), unlike `toggle` above.
  // Used by CTAs that are unambiguously asking to open chat — e.g. the
  // "Ask Claude about your portfolio" banner — where reusing the toggle
  // event would close an already-open rail on a second click (deep-QA
  // finding, 2026-08-20). Always ends with the composer focused: if the
  // panel was closed/collapsed, focus is deferred until the slide-in
  // transition finishes; if it was already open, focus fires immediately.
  const openChat = useCallback(() => {
    if (isLargeDesktop) {
      setCollapsed((v) => {
        if (v) {
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("focus-chat-input"));
          }, 220);
        } else {
          window.dispatchEvent(new CustomEvent("focus-chat-input"));
        }
        return false;
      });
      return;
    }
    setOpen((v) => {
      if (v) {
        window.dispatchEvent(new CustomEvent("focus-chat-input"));
      } else {
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("focus-chat-input"));
        }, 220);
      }
      return true;
    });
  }, [isLargeDesktop]);

  // Broadcast open-state for the header ChatToggleButton to mirror its
  // active styling. railVisible already accounts for collapse on large desktop.
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

  // open-chat from OpenChatButton (the "Ask Claude about your portfolio"
  // banner) — always opens + focuses, never closes. See openChat above.
  useEffect(() => {
    function handleOpen() {
      openChat();
    }
    window.addEventListener("open-chat", handleOpen);
    return () => window.removeEventListener("open-chat", handleOpen);
  }, [openChat]);

  // Compute the panel className per layout mode.
  const panelClass = isMobile
    ? `inset-0 ${open ? "translate-y-0" : "translate-y-full"}`
    : isLargeDesktop
      ? `top-0 electron:top-7 right-0 h-full electron:h-[calc(100%-1.75rem)] border-l border-edge ${
          collapsed ? "translate-x-full" : "translate-x-0"
        }`
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

      {/* Chat panel. max-w-[100vw] is a CSS-level belt-and-suspenders cap —
          the inline style's maxWidth: "90vw" (below) already wins via
          specificity whenever it applies, but this guards the drawer/rail
          from ever exceeding the viewport width if that inline style is
          ever absent (e.g. the isMobile branch, which renders `undefined`
          and relies on `inset-0` sizing instead). */}
      <div
        className={`fixed z-50 bg-canvas transform transition-transform duration-300 ease-in-out max-w-[100vw] ${panelClass}`}
        style={!isMobile ? { width: `${chatPanelWidthPx(expanded)}px`, maxWidth: "90vw" } : undefined}
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
                className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-2 text-ink-dim hover:text-ink transition-colors p-1 -ml-1 rounded-md"
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
            {/* Keyboard hint — meaningless on touch, hidden there */}
            {!isMobile && (
              <kbd className="pointer-coarse:hidden text-[10px] text-ink-faint font-mono bg-raised px-1.5 py-0.5 rounded border border-edge">
                {"⌘"}J
              </kbd>
            )}
            {/* Expand / narrow button (U2b) — desktop only (mobile is full-screen).
                Toggles the panel between the normal rail and the wider reading
                width; persisted via vgs:chatExpanded. */}
            {!isMobile && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 text-ink-faint hover:text-ink transition-colors p-1 rounded-md hover:bg-raised"
                aria-label={expanded ? "Narrow chat" : "Widen chat"}
                title={expanded ? "Narrow chat" : "Widen chat for reading"}
              >
                {expanded ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="4 14 10 14 10 20" />
                    <polyline points="20 10 14 10 14 4" />
                    <line x1="14" y1="10" x2="21" y2="3" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="15 3 21 3 21 9" />
                    <polyline points="9 21 3 21 3 15" />
                    <line x1="21" y1="3" x2="14" y2="10" />
                    <line x1="3" y1="21" x2="10" y2="14" />
                  </svg>
                )}
              </button>
            )}
            {/* Collapse button — only on the persistent large-desktop rail.
                Slides the rail off-screen + frees the layout reservation so
                content (esp. EarningsHub) gets full width. The header
                ChatToggleButton picks up at xl when collapsed for re-expand. */}
            {isLargeDesktop && (
              <button
                onClick={() => setCollapsed(true)}
                className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 text-ink-faint hover:text-ink transition-colors p-1 rounded-md hover:bg-raised"
                aria-label="Collapse chat rail"
                title="Collapse chat (Cmd+J)"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
            {/* Close button — drawer mode only (768–1279px). */}
            {!isLargeDesktop && (
              <button
                onClick={() => setOpen(false)}
                className="relative pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5 text-ink-faint hover:text-ink transition-colors p-1 rounded-md hover:bg-raised"
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
