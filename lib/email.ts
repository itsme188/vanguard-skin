import nodemailer from "nodemailer";

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
}

/**
 * Send an email via Resend's SMTP relay.
 *
 * Reads RESEND_API_KEY + RESEND_FROM_DOMAIN from env. Throws if either is
 * missing — caller surfaces that as a 500.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const domain = process.env.RESEND_FROM_DOMAIN;
  if (!apiKey || !domain) {
    throw new Error(
      "Missing RESEND_API_KEY or RESEND_FROM_DOMAIN env vars."
    );
  }

  const localPart = opts.fromLocalPart ?? "noreply";
  const fromAddress = `${localPart}@${domain}`;

  const transporter = nodemailer.createTransport({
    host: "smtp.resend.com",
    port: 465,
    secure: true,
    auth: { user: "resend", pass: apiKey },
  });

  await transporter.sendMail({
    from: `"${FROM_NAME}" <${fromAddress}>`,
    to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
    replyTo: opts.replyTo,
    subject: opts.subject,
    html: opts.html,
    text:
      opts.text ??
      opts.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  });
}
