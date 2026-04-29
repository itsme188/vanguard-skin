import { redirect } from "next/navigation";

// Cut from top-level nav 2026-04-29 (IA Phase 2). Today absorbs Overview.
// File preserved through Phase 8 cleanup in case external bookmarks land here.
export default function DashboardRoot() {
  redirect("/dashboard/today");
}
