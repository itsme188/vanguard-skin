import nodemailer from "nodemailer";

export interface EmailConfig {
  gmailAddress: string;
  gmailAppPassword: string;
}

/**
 * Send an email via Gmail SMTP using App Password authentication.
 */
export async function sendEmail(
  config: EmailConfig,
  to: string | string[],
  subject: string,
  html: string,
  text?: string
): Promise<void> {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: config.gmailAddress, pass: config.gmailAppPassword },
  });

  await transporter.sendMail({
    from: `"Vanguard Dashboard" <${config.gmailAddress}>`,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    html,
    text: text ?? html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  });
}
