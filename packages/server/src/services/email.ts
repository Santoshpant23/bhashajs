/**
 * Email service — sends transactional emails via SMTP.
 *
 * Uses any SMTP provider (Resend recommended for free tier — 3000/mo).
 * If SMTP env vars are missing, falls back to console logging so dev still works.
 *
 * Env vars expected (all optional — service is no-op if SMTP_HOST is unset):
 *   SMTP_HOST       — e.g. smtp.resend.com
 *   SMTP_PORT       — e.g. 465
 *   SMTP_USER       — e.g. resend
 *   SMTP_PASS       — your provider's API key / SMTP password
 *   SMTP_FROM       — e.g. "BhashaJS <noreply@bhashajs.com>"
 *   APP_URL         — e.g. https://app.bhashajs.com (for invite links)
 */

import nodemailer, { Transporter } from "nodemailer";

let transporter: Transporter | null = null;
let configChecked = false;

function getTransporter(): Transporter | null {
  if (configChecked) return transporter;
  configChecked = true;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    console.warn(
      "[email] SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS not all set — emails will be logged to console only."
    );
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(port),
    secure: Number(port) === 465, // 465 = TLS, others (587, 25) = STARTTLS
    auth: { user, pass },
  });

  return transporter;
}

interface SendInviteEmailArgs {
  to: string;
  inviterName: string;
  projectName: string;
  role: string;
  inviteToken: string;
}

export async function sendInviteEmail({
  to,
  inviterName,
  projectName,
  role,
  inviteToken,
}: SendInviteEmailArgs): Promise<void> {
  const appUrl = process.env.APP_URL || "https://app.bhashajs.com";
  const link = `${appUrl}/join?token=${inviteToken}`;
  const from = process.env.SMTP_FROM || "BhashaJS <noreply@bhashajs.com>";

  const subject = `${inviterName} invited you to "${projectName}" on BhashaJS`;

  const text = [
    `Hi,`,
    ``,
    `${inviterName} has invited you to collaborate on "${projectName}" as a ${role}.`,
    ``,
    `Accept the invite by visiting:`,
    link,
    ``,
    `If you don't have an account yet, you'll be prompted to create one.`,
    ``,
    `— BhashaJS`,
    `https://bhashajs.com`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;border:1px solid #e7e7eb;overflow:hidden;">
          <tr>
            <td style="padding:32px 40px;border-bottom:1px solid #f0f0f4;">
              <span style="font-family:'Noto Sans Devanagari',serif;font-size:24px;font-weight:700;color:#FF6B2C;">भा</span>
              <span style="font-size:18px;font-weight:600;color:#0E1116;margin-left:6px;vertical-align:middle;">bhasha-js</span>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h1 style="margin:0 0 16px;font-size:22px;color:#0E1116;line-height:1.3;">You're invited to "${escapeHtml(projectName)}"</h1>
              <p style="margin:0 0 16px;color:#4a5260;font-size:15px;line-height:1.6;">
                <strong>${escapeHtml(inviterName)}</strong> has invited you to collaborate on the BhashaJS project
                <strong>${escapeHtml(projectName)}</strong> as a <strong>${escapeHtml(role)}</strong>.
              </p>
              <p style="margin:0 0 24px;color:#4a5260;font-size:15px;line-height:1.6;">
                Click the button below to accept. If you don't have an account, you'll be prompted to create one.
              </p>
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background:#FF6B2C;">
                    <a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;">
                      Accept invite
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:32px 0 0;color:#8a92a0;font-size:13px;line-height:1.6;">
                Or paste this link into your browser:<br/>
                <a href="${escapeHtml(link)}" style="color:#5b6470;word-break:break-all;">${escapeHtml(link)}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 40px;background:#fafafc;border-top:1px solid #f0f0f4;color:#8a92a0;font-size:12px;text-align:center;">
              You received this because <strong>${escapeHtml(inviterName)}</strong> added <strong>${escapeHtml(to)}</strong> to a BhashaJS project.<br/>
              If you weren't expecting this, you can safely ignore this email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const t = getTransporter();
  if (!t) {
    console.log(`[email] (dry-run, SMTP not configured) Invite for ${to}: ${link}`);
    return;
  }

  try {
    await t.sendMail({ from, to, subject, text, html });
    console.log(`[email] Invite sent to ${to}`);
  } catch (e) {
    console.error(`[email] Failed to send invite to ${to}:`, e);
    // Non-fatal — the invite link is still valid, owner can copy/share manually.
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
