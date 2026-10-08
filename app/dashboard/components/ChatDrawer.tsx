"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
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

function ChatDrawerInner() {
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
  const panelRef = useRef<HTMLDivElement>(null);

  // The slide transition is armed only once the current layout mode has been
  // on screen for two frames. The first client render is always the 768px+
  // drawer (both media hooks start false), so at phone width the classes swap
  // from "off the right edge" to "off the bottom" one render later — with the
  // transition always on, the closed panel swept across the page on every
  // load. Same for a resize across a breakpoint. Open/close slides within one
  // mode are unaffected.
  const layoutMode = isMobile ? "mobile" : isLargeDesktop ? "rail" : "drawer";
  const [settledMode, setSettledMode] = useState<string | null>(null);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettledMode(layoutMode));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [layoutMode]);
  const slideArmed = settledMode === layoutMode;

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

  // Mobile: the full-screen overlay and the bottom nav are both z-50, so the
  // nav stays tappable while the overlay covers the page — a route change
  // means the user picked a destination, so dismiss the overlay to reveal it.
  // Keyed on search params too: the bottom nav's Notes slot is a query-only
  // navigation (/dashboard/research?view=notes), which never changes pathname.
  // Mobile-only: the ≥768px drawer sits over a backdrop and the xl rail is a
  // persistent side-by-side pane; neither hides the page behind it.
  const searchParams = useSearchParams();
  useEffect(() => {
    if (isMobile) setOpen(false);
  }, [pathname, searchParams, isMobile]);

  // At xl, the rail is conceptually always available — visible when the user
  // hasn't collapsed it. The panel slides off-screen when collapsed.
  const railVisible = isLargeDesktop ? !collapsed : open;

  // Collapse the large-desktop rail from its own button. The button sits inside
  // the panel that goes `inert` + aria-hidden on collapse, so focus must LEAVE
  // first: hand it to the header control that re-opens the rail (falls back to
  // <main>) instead of leaving it on a now-hidden element.
  const collapseRail = useCallback(() => {
    // Focus FIRST, synchronously, so no element inside the rail still holds
    // focus when the subtree turns aria-hidden/inert (browser warns otherwise).
    const findReopen = () =>
      document.querySelector<HTMLElement>('button[aria-label="Toggle chat assistant"]');
    const reopen = findReopen();
    const reopenVisible = reopen !== null && reopen.offsetParent !== null;
    const main = document.querySelector<HTMLElement>("main");
    if (main && !main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    (reopenVisible ? reopen : main)?.focus();
    setCollapsed(true);
    if (!reopenVisible) {
      // The toggle only appears after collapse: hand focus to it once it exists.
      setTimeout(() => {
        const late = findReopen();
        if (late && late.offsetParent !== null) late.focus();
      }, 0);
    }
  }, []);

  // Close the phone overlay / the 768–1279px drawer. Same rule as collapseRail
  // above: the panel turns aria-hidden + inert on close, so if focus is inside
  // it (the Close button that was just tapped, the composer on Escape) it must
  // LEAVE first — Chromium otherwise logs "Blocked aria-hidden on an element
  // because its descendant retained focus". Focus goes to the control that
  // re-opens chat (bottom-nav Chat on a phone, the header toggle on desktop),
  // else <main>. A close with focus already outside (backdrop click, route
  // change) moves nothing.
  const releaseFocus = useCallback(() => {
    const panel = panelRef.current;
    const active = document.activeElement;
    if (!panel || !active || !panel.contains(active)) return;
    const opener = [
      'button[aria-label="Open chat"]',
      'button[aria-label="Toggle chat assistant"]',
    ]
      .map((sel) => document.querySelector<HTMLElement>(sel))
      .find((el) => el !== null && el.offsetParent !== null);
    const main = document.querySelector<HTMLElement>("main");
    if (!opener && main && !main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    // preventScroll: closing chat must not move the page under it.
    (opener ?? main)?.focus({ preventScroll: true });
  }, []);

  const closeDrawer = useCallback(() => {
    releaseFocus();
    setOpen(false);
  }, [releaseFocus]);

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
    if (open) {
      closeDrawer();
      return;
    }
    setOpen(true);
    // Move focus INTO the dialog once it has slid in (it is inert until the
    // open render). On a phone that is the panel itself — focusing the
    // composer would raise the keyboard over the conversation list on every
    // bottom-nav tap; on the drawer it is the composer, as on the rail.
    setTimeout(() => {
      if (isMobile) {
        panelRef.current?.focus({ preventScroll: true });
      } else {
        window.dispatchEvent(new CustomEvent("focus-chat-input"));
      }
    }, 220);
  }, [isLargeDesktop, isMobile, open, closeDrawer]);

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
        closeDrawer();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, isLargeDesktop, toggle, closeDrawer]);

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
          onClick={closeDrawer}
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
        ref={panelRef}
        /* tabIndex -1: the phone overlay takes focus itself on open (see
           toggle); outline-none because that focus is programmatic only. */
        tabIndex={-1}
        className={`fixed z-50 bg-canvas transform ${slideArmed ? "transition-transform duration-300 ease-in-out" : ""} max-w-[100vw] outline-none ${panelClass}`}
        style={!isMobile ? { width: `${chatPanelWidthPx(expanded)}px`, maxWidth: "90vw" } : undefined}
        role={isLargeDesktop ? "complementary" : "dialog"}
        aria-label="Chat assistant"
        aria-modal={isMobile ? true : undefined}
        aria-hidden={!railVisible}
        /* The panel is never unmounted (that would drop the conversation) and
           hides by sliding off-screen with a transform — which removes it from
           NOTHING. aria-hidden alone left ~48 enabled controls in the tab
           order, one "Delete conversation" per stored conversation among
           them: a single Tab out of <main> put focus ~91px off the right edge
           with no visible ring, and Chromium refused the aria-hidden outright
           ("Blocked aria-hidden on an element because its descendant retained
           focus... Consider using the inert attribute instead"). `inert`
           (React 19 boolean prop) takes the subtree out of the tab order and
           the accessibility tree together, on the SAME predicate, so the two
           can never disagree. Every re-open control lives outside this
           subtree: the header ChatToggleButton (rendered by the dashboard
           layout) and the window-level Cmd+J / toggle-mobile-chat / open-chat
           listeners. QA 2026-09-07. */
        inert={!railVisible}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-2">
            {isMobile ? (
              <button
                onClick={closeDrawer}
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
                onClick={collapseRail}
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
                onClick={closeDrawer}
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

// useSearchParams forces a Suspense boundary per Next.js 16 (same rule as
// MobileBottomNav in this layout). Wrap so the rest of the layout renders
// without the drawer holding it back.
export function ChatDrawer() {
  return (
    <Suspense fallback={null}>
      <ChatDrawerInner />
    </Suspense>
  );
}
