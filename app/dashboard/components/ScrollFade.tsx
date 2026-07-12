"use client";

import { useRef, useEffect, type ReactNode } from "react";

export function ScrollFade({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  // Two refs: `ref` is the inner overflow-x-auto scroller (what we measure
  // scrollWidth/scrollLeft on), `wrapperRef` is the outer `.scroll-fade` div
  // that globals.css's `.scroll-fade.is-scrollable::after` gradient rule
  // actually targets. Toggling the class on the wrong element (the inner
  // div) left the fade permanently inert app-wide — see globals.css comment.
  const ref = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const wrapper = wrapperRef.current;
    if (!el || !wrapper) return;

    function check() {
      if (!el || !wrapper) return;
      const isScrollable = el.scrollWidth > el.clientWidth + 1;
      const isAtEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      wrapper.classList.toggle("is-scrollable", isScrollable && !isAtEnd);
    }

    check();
    el.addEventListener("scroll", check, { passive: true });
    const observer = new ResizeObserver(check);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", check);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={wrapperRef} className={`scroll-fade ${className}`}>
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
