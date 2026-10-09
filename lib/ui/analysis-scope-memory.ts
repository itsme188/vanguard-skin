// Session memory for the Analysis tab's account scope. Owner ruling: leaving
// Analysis and coming back through the nav should land on the scope last
// chosen, for the session only (sessionStorage); a fresh launch still opens on
// each view's ruled default. Plain functions with an injected storage so they
// test without a DOM. Every storage access is guarded: private mode or blocked
// storage falls back to "no memory".

export const ANALYSIS_SCOPE_KEY = "vgs:analysis-scope";

// Same tokens as the scope pills on the Analysis page (VALID_SCOPES).
export const ANALYSIS_SCOPE_TOKENS = ["vanguard", "ibkr", "roth", "all"] as const;

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isKnownAnalysisScope(value: string | null | undefined): value is string {
  return !!value && (ANALYSIS_SCOPE_TOKENS as readonly string[]).includes(value);
}

export function isAnalysisPath(pathname: string): boolean {
  return pathname === "/dashboard/analysis" || pathname.startsWith("/dashboard/analysis/");
}

export function readRememberedScope(storage: StorageLike | null | undefined): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(ANALYSIS_SCOPE_KEY);
    return isKnownAnalysisScope(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberScope(storage: StorageLike | null | undefined, scope: string | null): void {
  if (!storage || !isKnownAnalysisScope(scope)) return;
  try {
    storage.setItem(ANALYSIS_SCOPE_KEY, scope);
  } catch {
    // Storage blocked: nothing to remember, the nav works as before.
  }
}

// Adds ?scope=<remembered> to an Analysis link when the user is NOT on an
// Analysis page (on one, the live URL scope is already carried by
// withPreservedParams). Any other href is returned untouched.
export function rememberedScopeHref(
  href: string,
  remembered: string | null,
  currentPathname: string,
): string {
  if (!isKnownAnalysisScope(remembered)) return href;
  if (isAnalysisPath(currentPathname)) return href;
  const [pathPart, query = ""] = href.split("?");
  if (!isAnalysisPath(pathPart)) return href;
  if (new URLSearchParams(query).has("scope")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}scope=${remembered}`;
}
