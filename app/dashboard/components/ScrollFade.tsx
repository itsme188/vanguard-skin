"use client";

import { useRef, useEffect, type ReactNode } from "react";

export function ScrollFade({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function check() {
      if (!el) return;
      const isScrollable = el.scrollWidth > el.clientWidth + 1;
      const isAtEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      el.classList.toggle("is-scrollable", isScrollable && !isAtEnd);
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
    <div className={`scroll-fade ${className}`}>
      <div ref={ref} className="overflow-x-auto">
        {children}
      </div>
    </div>
  );
}
