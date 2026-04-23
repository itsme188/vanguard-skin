"use client";

import type { ReactNode } from "react";
import {
  formatNumber,
  formatPercent,
  formatShares,
  formatUSD,
  formatUSDPrecise,
} from "@/lib/format";
import { usePrivacy } from "./context";

const MASK = "•••";

interface MoneyProps {
  value: number | null | undefined;
  precise?: boolean;
  signed?: boolean;
  fallback?: string;
  className?: string;
  /**
   * Omit the leading `$` glyph — useful for display patterns that render
   * the currency symbol separately (e.g. the faint-`$` + big-amber-number
   * split in the Terminal hero). Negative values still get a "−" prefix;
   * `signed` still controls the explicit "+".
   */
  bare?: boolean;
}

export function Money({
  value,
  precise = false,
  signed = false,
  fallback = "—",
  className,
  bare = false,
}: MoneyProps) {
  const { isPrivate } = usePrivacy();
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{fallback}</span>;
  }
  if (isPrivate) {
    return <span className={className}>{MASK}</span>;
  }
  const formatter = precise ? formatUSDPrecise : formatUSD;
  const formatted = formatter(Math.abs(value));
  // formatter output always begins with "$" — strip it when `bare`.
  const numeric = bare ? formatted.replace(/^\$/, "") : formatted;
  const sign = signed && value > 0 ? "+" : value < 0 ? "−" : "";
  return <span className={className}>{`${sign}${numeric}`}</span>;
}

interface PctProps {
  value: number | null | undefined;
  digits?: number;
  signed?: boolean;
  fallback?: string;
  className?: string;
}

export function Pct({
  value,
  digits = 1,
  signed = false,
  fallback = "—",
  className,
}: PctProps) {
  const { isPrivate } = usePrivacy();
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{fallback}</span>;
  }
  if (isPrivate) {
    return <span className={className}>{MASK}</span>;
  }
  const formatted = formatPercent(Math.abs(value), digits);
  const sign = signed && value > 0 ? "+" : value < 0 ? "−" : "";
  return <span className={className}>{`${sign}${formatted}`}</span>;
}

interface SharesProps {
  value: number | null | undefined;
  digits?: number;
  fallback?: string;
  className?: string;
}

export function Shares({
  value,
  digits = 0,
  fallback = "—",
  className,
}: SharesProps) {
  const { isPrivate } = usePrivacy();
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{fallback}</span>;
  }
  if (isPrivate) {
    return <span className={className}>{MASK}</span>;
  }
  return <span className={className}>{formatShares(value, digits)}</span>;
}

interface CountProps {
  value: number | null | undefined;
  fallback?: string;
  className?: string;
}

export function Count({ value, fallback = "—", className }: CountProps) {
  const { isPrivate } = usePrivacy();
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{fallback}</span>;
  }
  if (isPrivate) {
    return <span className={className}>{MASK}</span>;
  }
  return <span className={className}>{formatNumber(value)}</span>;
}

interface PrivateTextProps {
  children: ReactNode;
  className?: string;
}

export function PrivateText({ children, className }: PrivateTextProps) {
  const { isPrivate } = usePrivacy();
  return (
    <span className={className}>{isPrivate ? MASK : children}</span>
  );
}

/**
 * Wrap a Recharts-style formatter so it returns the mask when privacy is on.
 * Recharts re-reads the prop each render, so flipping `isPrivate` re-renders
 * the axis/tooltip immediately.
 */
export function usePrivateFormatter<T>(
  visible: (v: T) => string,
): (v: T) => string {
  const { isPrivate } = usePrivacy();
  return (v) => (isPrivate ? MASK : visible(v));
}
