"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export type SortDir = "asc" | "desc";

export type SortState<Field extends string> = {
  field: Field | null;
  dir: SortDir;
};

/**
 * Read + write a tri-state sort from URL search params.
 *
 * Each table owns a scope (e.g. "holdings", "alerts") so multiple sortable
 * tables can coexist on the same page: `?holdingsSort=gain&holdingsDir=desc`.
 *
 * Click cycle: asc → desc → cleared (falls back to default order).
 */
export function useSortParam<Field extends string>(
  scope: string,
  defaultField: Field | null = null,
  defaultDir: SortDir = "desc",
): {
  sort: SortState<Field>;
  setSort: (field: Field) => void;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sortKey = `${scope}Sort`;
  const dirKey = `${scope}Dir`;

  const sort = useMemo<SortState<Field>>(() => {
    const field = (searchParams.get(sortKey) as Field | null) ?? defaultField;
    const dirParam = searchParams.get(dirKey);
    const dir: SortDir = dirParam === "asc" || dirParam === "desc" ? dirParam : defaultDir;
    return { field, dir };
  }, [searchParams, sortKey, dirKey, defaultField, defaultDir]);

  const setSort = useCallback(
    (field: Field) => {
      const next = new URLSearchParams(searchParams.toString());
      const currentField = next.get(sortKey);
      const currentDir = next.get(dirKey);

      if (currentField !== field) {
        next.set(sortKey, field);
        next.set(dirKey, "desc");
      } else if (currentDir === "desc") {
        next.set(sortKey, field);
        next.set(dirKey, "asc");
      } else {
        next.delete(sortKey);
        next.delete(dirKey);
      }

      const qs = next.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, searchParams, sortKey, dirKey],
  );

  return { sort, setSort };
}

/**
 * Stable comparator for `Array.prototype.sort`. Handles null/undefined
 * (always sorted to the end regardless of direction) and strings vs numbers.
 */
export function compareValues(
  a: unknown,
  b: unknown,
  dir: SortDir,
): number {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;

  if (typeof a === "number" && typeof b === "number") {
    return dir === "asc" ? a - b : b - a;
  }

  const aStr = String(a).toLowerCase();
  const bStr = String(b).toLowerCase();
  if (aStr < bStr) return dir === "asc" ? -1 : 1;
  if (aStr > bStr) return dir === "asc" ? 1 : -1;
  return 0;
}
