/**
 * Pushover push-notification wrapper.
 *
 * Gracefully degrades when either env var is missing — the caller can fire
 * this for every alert without first checking whether Pushover is configured.
 *
 * Pushover API docs: https://pushover.net/api
 * Free tier: 10,000 msgs/mo/app. Alerts are sparse enough to never hit this.
 */

export interface PushoverMessage {
  title: string;
  message: string;
  /** Deep link opened when the user taps the notification. */
  url?: string;
  /** Label for the URL button. Default: "Open". */
  urlTitle?: string;
  /** -2..2. 0 = normal, 1 = high-priority, 2 = emergency (repeats until ack). */
  priority?: -2 | -1 | 0 | 1 | 2;
  /** Pushover sound name. Default: cosmic. See https://pushover.net/api#sounds. */
  sound?: string;
}

export interface PushoverResult {
  sent: boolean;
  reason?: string;
  requestId?: string;
}

const ENDPOINT = "https://api.pushover.net/1/messages.json";

export async function sendPushover(msg: PushoverMessage): Promise<PushoverResult> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    return { sent: false, reason: "pushover_not_configured" };
  }

  const body = new URLSearchParams({
    token,
    user,
    title: msg.title,
    message: msg.message,
  });
  if (msg.url) body.set("url", msg.url);
  if (msg.urlTitle) body.set("url_title", msg.urlTitle);
  if (msg.priority !== undefined) body.set("priority", String(msg.priority));
  if (msg.sound) body.set("sound", msg.sound);

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as {
      status?: number;
      request?: string;
      errors?: string[];
    };
    if (json.status === 1) {
      return { sent: true, requestId: json.request };
    }
    return {
      sent: false,
      reason: json.errors?.join("; ") ?? `http_${res.status}`,
    };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "network_error",
    };
  }
}

/**
 * Convenience: format and send a level-alert push.
 *
 * Example push:
 *   Title: "HOOD ENTRY hit"
 *   Message: "Triggered @ $91.32 — Helene Meisler — held 300 sh"
 *   URL: vanguard-skin:///dashboard/security/1735  (opens in browser → deep link later)
 */
export async function sendLevelAlertPush(args: {
  symbol: string;
  levelType: string;
  triggeredPrice: number;
  sourceAuthor: string | null;
  heldQuantity: number | null;
  securityId: number;
  baseUrl?: string;
}): Promise<PushoverResult> {
  const fmtPrice = (n: number) =>
    `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const base = args.baseUrl ?? process.env.PUSHOVER_LINK_BASE ?? "http://localhost:3099";
  const parts = [`Triggered @ ${fmtPrice(args.triggeredPrice)}`];
  if (args.sourceAuthor) parts.push(args.sourceAuthor);
  if (args.heldQuantity && args.heldQuantity > 0) parts.push(`held ${args.heldQuantity} sh`);
  return sendPushover({
    title: `${args.symbol} ${args.levelType.replace("_", " ").toUpperCase()} hit`,
    message: parts.join(" — "),
    url: `${base}/dashboard/security/${args.securityId}`,
    urlTitle: "Open in dashboard",
  });
}
