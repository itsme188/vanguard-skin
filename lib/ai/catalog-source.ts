/**
 * Injection seam + cache for the available-model catalog, exactly mirroring
 * lib/ai/override-source.ts. lib/ai/models.ts is imported at module top-level by
 * many AI modules; importing the lib/db singleton from here would open the real
 * DB as a side effect. Instead lib/db.ts registers a SQLite-backed reader after
 * the singleton is created; tests inject a stub; any context without a source
 * (Workers, in-memory test DBs) falls back to [] → static tier fallback.
 *
 * dropModelFromCatalog removes an id from the in-memory working set so reactive
 * failover can skip a just-404'd model immediately, before the next refresh.
 */

export type ModelCatalogReader = () => string[];

const TTL_MS = 30_000;

let reader: ModelCatalogReader | null = null;
let cache: { value: string[]; readAt: number } | null = null;

export function setModelCatalogSource(fn: ModelCatalogReader | null): void {
  reader = fn;
  cache = null;
}

export function invalidateModelCatalogCache(): void {
  cache = null;
}

/** Remove an id from the current cached working set (reactive failover). */
export function dropModelFromCatalog(id: string): void {
  const current = getCachedModelCatalog();
  cache = { value: current.filter((m) => m !== id), readAt: Date.now() };
}

export function getCachedModelCatalog(): string[] {
  if (!reader) return [];
  const now = Date.now();
  if (cache && now - cache.readAt < TTL_MS) return cache.value;
  let value: string[] = [];
  try {
    value = reader() ?? [];
  } catch {
    value = [];
  }
  cache = { value, readAt: now };
  return value;
}
