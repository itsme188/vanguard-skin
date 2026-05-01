import { redirect } from "next/navigation";

// Cut from top-level nav 2026-04-29 (IA Phase 2). Phase 3 builds a "week ahead"
// sub-view on Today that absorbs the calendar role. Until then the redirect
// lands on Today; the ?view query param is forward-compat for that sub-view.
export default function CalendarRedirect() {
  redirect("/dashboard/today?view=week-ahead");
}
