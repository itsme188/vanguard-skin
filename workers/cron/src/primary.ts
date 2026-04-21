/**
 * Primary path — call the Mac webhook at MESH_HOSTNAME.
 *
 * MESH_HOSTNAME is a Worker secret; expected form is a full origin including
 * scheme, e.g. `http://100.96.0.1:3099` (Cloudflare Mesh internal IP) or
 * `https://mesh.example.com` (public tunnel). No trailing slash.
 */

import type { JobType } from "./dedup";

export type PrimaryResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "skipped_by_mac"; status: number; body: unknown } // Mac route said cloud already sent (shouldn't happen pre-Session-C)
  | { kind: "timeout" }
  | { kind: "network_error"; message: string }
  | { kind: "server_error"; status: number; body: unknown };

export interface PrimaryOpts {
  meshHostname: string;
  cronSecret: string;
  type: JobType;
  timeoutMs: number;
  body?: Record<string, unknown>;
}

export async function callPrimary(opts: PrimaryOpts): Promise<PrimaryResult> {
  const url = `${opts.meshHostname.replace(/\/$/, "")}/api/cron/${opts.type}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cron-Secret": opts.cronSecret,
      },
      body: JSON.stringify(opts.body ?? {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }

    if (res.ok) {
      // Mac returns { skipped: true, reason: "..." } when it saw a cloud-sent marker.
      if (typeof body === "object" && body && (body as { skipped?: boolean }).skipped) {
        return { kind: "skipped_by_mac", status: res.status, body };
      }
      return { kind: "success", status: res.status, body };
    }
    return { kind: "server_error", status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { kind: "timeout" };
    }
    return {
      kind: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
