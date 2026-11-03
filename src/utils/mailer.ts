import { env } from "../config/env";
import { logger } from "./logger";

type Mail = { to: string; subject: string; html: string; text: string };

/**
 * Sends email through Resend (https://resend.com) when RESEND_API_KEY is set.
 * Without a key (local development) the email is written to the server log
 * instead, so flows like "forgot password" still work end to end.
 * Never throws: a failed email must not fail the request that caused it.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, "📧 Email (not sent: no RESEND_API_KEY)");
    return false;
  }
  try {
    const res = await fetch(`${env.RESEND_API_BASE}/emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text(), to: mail.to }, "Email failed to send");
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, to: mail.to }, "Email failed to send");
    return false;
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * One simple, readable layout for every Hisaab email (works in Gmail and Outlook:
 * tables and inline styles only). Pass plain text; it is escaped here.
 */
export function emailLayout(opts: { heading: string; lines: string[]; button?: { label: string; url: string }; footer?: string }) {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#1a1d3a">${escapeHtml(t)}</p>`;
  const button = opts.button
    ? `<a href="${escapeHtml(opts.button.url)}" style="display:inline-block;background:#1a1d3a;color:#f4f5f0;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px;font-size:15px">${escapeHtml(opts.button.label)}</a>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f0;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:2px solid #1a1d3a;border-radius:20px">
<tr><td style="padding:22px 26px 0"><span style="font-size:22px;font-weight:800;color:#1a1d3a">hisaab</span></td></tr>
<tr><td style="padding:18px 26px 26px">
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#1a1d3a">${escapeHtml(opts.heading)}</h1>
${opts.lines.map(p).join("")}${button}
</td></tr></table>
<p style="max-width:520px;margin:14px auto 0;font-size:12px;line-height:1.5;color:#4b5070">${escapeHtml(
    opts.footer ?? "You get this because you use Hisaab. Turn these emails off in Settings.",
  )}</p>
</td></tr></table></body></html>`;
  const text = [opts.heading, "", ...opts.lines, ...(opts.button ? ["", `${opts.button.label}: ${opts.button.url}`] : [])].join("\n");
  return { html, text };
}
