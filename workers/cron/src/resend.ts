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
  const body: Record<string, unknown> = {
    from: `${FROM_NAME} <${fromAddress}>`,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.replyTo) body.reply_to = opts.replyTo;

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
