import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decideRequest, type RequestCtx } from "@/lib/auth/verify-request";
import { touchSession } from "@/lib/mutations/sessions";

// Packaged-app trust boundary (#35, task 18) — THE choke point. Next 16.1.6
// uses the `proxy` file convention (not `middleware.ts`) and proxy ALWAYS runs
// on the Node.js runtime, so importing the Node-only db singleton (better-
// sqlite3) here is safe — do NOT add `export const runtime` (route segment
// config is rejected in a proxy file). Every request except immutable static
// assets flows through decideRequest; default-deny.

// Match everything EXCEPT verified immutable static assets. Deliberately NOT a
// blanket `/_next/*`: Next's dynamic data/RSC payloads for protected pages
// carry portfolio data and must go through the same boundary. decideRequest's
// isImmutableAsset() is the authoritative exemption; this matcher only spares
// the framework the cost of invoking the proxy for build-hashed chunks.
export const config = {
  matcher: ["/((?!_next/static|favicon.ico|robots.txt).*)"],
};

// Session idle-window slide throttle — must match the store's throttle window
// (5 minutes); the conditional UPDATE in touchSession makes repeated calls
// inside the window cheap no-ops.
const TOUCH_THROTTLE_MS = 5 * 60_000;

export default function proxy(req: NextRequest): NextResponse {
  const url = new URL(req.url);
  const pathname = url.pathname;

  const hostname = process.env.APP_PUBLIC_HOSTNAME || "app.myportfoliodesk.com";

  const ctx: RequestCtx = {
    method: req.method,
    pathname,
    host: req.headers.get("host") ?? "",
    cookies: Object.fromEntries(req.cookies.getAll().map((c) => [c.name, c.value])),
    headers: {
      origin: req.headers.get("origin") ?? undefined,
      "x-csrf-token": req.headers.get("x-csrf-token") ?? undefined,
      "x-cron-secret": req.headers.get("x-cron-secret") ?? undefined,
      "x-electron-cred": req.headers.get("x-electron-cred") ?? undefined,
    },
    hosts: new Set([
      "localhost:3099",
      "127.0.0.1:3099",
      "localhost:3000",
      "127.0.0.1:3000",
      hostname,
    ]),
    origins: new Set([
      "http://localhost:3099",
      "http://127.0.0.1:3099",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      `https://${hostname}`,
    ]),
    cronSecret: process.env.CRON_SHARED_SECRET || "",
    electronCred: process.env.ELECTRON_SERVICE_CRED || "",
  };

  const decision = decideRequest(db, ctx, Date.now());

  if (decision.action === "allow") {
    if (decision.touchId) {
      touchSession(db, decision.touchId, Date.now(), TOUCH_THROTTLE_MS);
    }
    return NextResponse.next();
  }

  if (decision.action === "redirectLogin") {
    // Preserve where the user was headed so the login flow can bounce back.
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, req.url));
  }

  return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
}
