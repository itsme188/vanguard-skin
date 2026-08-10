import { redirect } from "next/navigation";

// Cut from top-level nav 2026-04-29 (IA Phase 2) — Overview's role was absorbed
// into Today. The other cut routes got redirect stubs for external bookmarks
// (iPhone home-screen shortcuts); this one was documented but never created, so
// the old bookmark 404'd. Same 5-line stub as calendar/holdings.
export default function OverviewRedirect() {
  redirect("/dashboard/today");
}
