/**
 * Pushover REST client for the Worker (cloud-side fan-out).
 *
 * Mirrors `lib/alerts/notify-pushover.ts` API surface but reads tokens from
 * Worker env instead of process.env. Graceful no-op when either secret is
 * missing — caller can fire-and-forget without first checking config.
 *
 * Pushover free tier: 10,000 msgs/mo/app. Level alerts are sparse enough
 * to never approach this.
 */

export interface PushoverEnv {
  PUSHOVER_APP_TOKEN?: string;
  PUSHOVER_USER_KEY?: string;
  /** Optional deep-link base — defaults to MESH_HOSTNAME when present. */
  PUSHOVER_LINK_BASE?: string;
  MESH_HOSTNAME?: string;
}

export interface PushoverResult {
  sent: boolean;
  reason?: string;
  requestId?: string;
}

const ENDPOINT = "https://api.pushover.net/1/messages.json";

export async function sendPushover(
  env: PushoverEnv,
  msg: { title: string; message: string; url?: string; urlTitle?: string },
): Promise<PushoverResult> {
  const token = env.PUSHOVER_APP_TOKEN;
  const user = env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    return { sent: false, reason: "pushover_not_configured" };
  }

  const body = new URLSearchParams({ token, user, title: msg.title, message: msg.message });
  if (msg.url) body.set("url", msg.url);
  if (msg.urlTitle) body.set("url_title", msg.urlTitle);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { status?: number; request?: string; errors?: string[] };
    if (json.status === 1) return { sent: true, requestId: json.request };
    return { sent: false, reason: json.errors?.join("; ") ?? `http_${res.status}` };
  } catch (err) {
    return { sent: false, reason: err instanceof Error ? err.message : "network_error" };
  }
}

export interface LevelPushArgs {
  symbol: string;
  levelType: string;
  triggeredPrice: number;
  sourceAuthor: string | null;
  securityId: number;
  /**
   * The level's `armed_crossed_at` — set when it was force-armed while
   * already past its threshold. When present, the push discloses that this
   * isn't a fresh cross instead of presenting it as one. Mirrors the same
   * field on the Mac sibling (lib/alerts/notify-pushover.ts).
   */
  armedCrossedAt?: string | null;
}

/**
 * Format and send a level-alert push. Output matches the Mac sibling at
 * lib/alerts/notify-pushover.ts so phones receive a consistent notification
 * shape regardless of which side fired.
 */
export async function sendLevelAlertPush(
  env: PushoverEnv,
  args: LevelPushArgs,
): Promise<PushoverResult> {
  const fmtPrice = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const base =
    env.PUSHOVER_LINK_BASE ??
    (env.MESH_HOSTNAME ? `https://${env.MESH_HOSTNAME}` : "http://localhost:3099");
  const parts = [`Triggered @ ${fmtPrice(args.triggeredPrice)}`];
  if (args.armedCrossedAt) parts.push("was already past this level when it was armed");
  if (args.sourceAuthor) parts.push(args.sourceAuthor);
  parts.push("cloud-fired");
  return sendPushover(env, {
    title: `${args.symbol} ${args.levelType.replace("_", " ").toUpperCase()} hit`,
    message: parts.join(" — "),
    url: `${base}/dashboard/security/${args.securityId}`,
    urlTitle: "Open in dashboard",
  });
}
