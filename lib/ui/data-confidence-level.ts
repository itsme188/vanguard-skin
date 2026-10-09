// Plain module on purpose: the Data Health page is a server component and
// cannot call a function exported from a "use client" file (it crashed the
// page on 2026-10-08). Both the server page and client components import
// the wording from here.

/**
 * Plain wording for a confidence level — the same words the header badge uses
 * (DataConfidenceIndicator's LEVEL_CONFIG), so the page and the badge agree.
 */
export function dataConfidenceLevelLabel(
  level: "high" | "medium" | "low" | "stale" | "unverified",
): string {
  switch (level) {
    case "high":
      return "Data reliable";
    case "medium":
      return "Some data stale";
    case "low":
      return "Data unreliable";
    case "stale":
      return "Data very stale";
    case "unverified":
      return "Verification incomplete";
  }
}
