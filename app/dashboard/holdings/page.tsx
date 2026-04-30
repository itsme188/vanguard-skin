import { redirect } from "next/navigation";

// Cut from top-level nav 2026-04-29 (IA Phase 2). Cmd+K ticker-jump replaces
// the per-symbol nav-shortcut role; Phase 6 absorbed the cross-account positions
// table into Accounts. iPhone home-screen shortcut may still link here, so the
// file stays as a redirect through Phase 8.
export default function HoldingsRedirect() {
  redirect("/dashboard/accounts?id=all#holdings");
}
