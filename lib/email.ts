import nodemailer from "nodemailer";
import { randomUUID } from "node:crypto";

const FROM_NAME = "Portfolio Desk";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  /**
   * Local-part of the From address. Lets each surface (briefing, digest,
   * earnings) send from a distinct address so recipients can filter and
   * deliverability per surface stays separable.
   * Default: "noreply".
   */
  fromLocalPart?: string;
  /** Reply-To header so user replies don't disappear into a no-reply mailbox. */
  replyTo?: string;
  /**
   * Caller-minted Message-ID, same `<uuid@domain>` shape this function mints
   * by default. The earnings send service (lib/earnings/send-service.ts) mints
   * it BEFORE the provider call and stores it on the audit row, so a send whose
   * outcome is never learned can still be found in the mailbox or the Resend log.
   */
  messageId?: string;
}

/** What the provider said. `response` is nodemailer's raw SMTP reply line. */
export interface SendEmailResult {
  messageId: string;
  response: string;
}

/**
 * Send an email via Resend's SMTP relay.
 *
 * Reads RESEND_API_KEY + RESEND_FROM_DOMAIN from env. Throws if either is
 * missing — caller surfaces that as a 500.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_FROM_DOMAIN;
  if (!apiKey || !domain) {
    throw new Error(
      "Missing RESEND_API_KEY or RESEND_FROM_DOMAIN env vars."
    );
  }

  const localPart = opts.fromLocalPart ?? "noreply";
  const fromAddress = `${localPart}@${domain}`;

  // Determine Reply-To: opts.replyTo > env var > default
  const replyToAddress =
    opts.replyTo ??
    process.env.REPLY_TO_ADDRESS ??
    `replies@${domain}`;

  // Caller-minted Message-ID wins; otherwise mint one, same as before.
  const messageId = opts.messageId ?? `<${randomUUID()}@${domain}>`;

  const transporter = nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    auth: { user: "resend", pass: apiKey },
  });

  const info = (await transporter.sendMail({
    from: `"${FROM_NAME}" <${fromAddress}>`,
    to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
    replyTo: replyToAddress,
    subject: opts.subject,
    html: opts.html,
    text:
      opts.text ??
      opts.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    headers: {
      "List-Unsubscribe": `<mailto:unsubscribe@${domain}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "Message-ID": messageId,
    },
  })) as { messageId?: unknown; response?: unknown } | undefined;

  // nodemailer reports the header we set (mime-node returns an existing
  // Message-ID rather than generating one), but never trust a transport to
  // populate a field: the id we PUT on the wire is the id we stored, so it is
  // the honest fallback.
  return {
    messageId: typeof info?.messageId === "string" && info.messageId ? info.messageId : messageId,
    response: typeof info?.response === "string" ? info.response : "",
  };
}
