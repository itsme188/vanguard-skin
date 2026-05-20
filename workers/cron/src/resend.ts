/**
 * Minimal Resend REST client for the Worker fallback paths.
 *
 * Workers runtime has no nodemailer; we POST directly to Resend's REST API.
 * Caller passes a fromLocalPart ("briefing" / "digest" / "earnings") so each
 * cloud-fallback email lands from the same address as its Mac counterpart.
 */

const FROM_NAME = "Portfolio Desk";

export interface ResendEnv {
  RESEND_API_KEY?: string;
  RESEND_FROM_DOMAIN?: string;
}

export interface SendOptions {
  to: string;
  subject: string;
  html: string;
  fromLocalPart: string;
  replyTo?: string;
}

export async function sendEmail(
  env: ResendEnv,
  opts: SendOptions
): Promise<{ id: string }> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_DOMAIN) {
    throw new Error(
      "Resend env missing (RESEND_API_KEY / RESEND_FROM_DOMAIN)."
    );
  }

  const fromAddress = `${opts.fromLocalPart}@${env.RESEND_FROM_DOMAIN}`;

  // Generate unique Message-ID matching <uuid@domain> format
  const messageId = `<${crypto.randomUUID()}@${env.RESEND_FROM_DOMAIN}>`;

  // Determine Reply-To: opts.replyTo > default
  const replyToAddress =
    opts.replyTo ?? `replies@${env.RESEND_FROM_DOMAIN}`;

  // Resend REST expects `to` as an array of single addresses ("a@b.com" or
  // "Name <a@b.com>"), NOT a single comma-joined string. Callers may pass
  // comma-separated values like "a@x.com, b@y.com" from BRIEFING_EMAIL_TO —
  // Mac's nodemailer handles those natively, but Resend REST 422s with
  // "Invalid `to` field". Split here so all Worker fallbacks (digest +
  // briefing + evening) work with multi-recipient configs.
  const toList = opts.to
    .split(",")
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);

  const body: Record<string, unknown> = {
    from: `${FROM_NAME} <${fromAddress}>`,
    to: toList,
    subject: opts.subject,
    html: opts.html,
    reply_to: replyToAddress,
    headers: {
      "List-Unsubscribe": `<mailto:unsubscribe@${env.RESEND_FROM_DOMAIN}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "Message-ID": messageId,
    },
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as { id: string };
}
