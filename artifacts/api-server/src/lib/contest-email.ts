import nodemailer from "nodemailer";
import { logger } from "./logger";
import { isDemoMode } from "./demo-mode";

/**
 * Recipients of the contest-approval notification, from the comma-separated
 * CONTEST_NOTIFY_EMAILS env var. No hard-coded fallback: when it is unset the
 * notification is simply skipped (see sendContestNotification).
 */
function notifyEmails(): string[] {
  return (process.env.CONTEST_NOTIFY_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendContestNotification(contest: {
  title: string;
  objective?: string | null;
  metric: string;
  startDate: string;
  endDate: string;
  createdByName: string;
  rewardDetails?: string | null;
  eligibility?: string | null;
  incentiveStructure?: string | null;
  product?: string | null;
}): Promise<void> {
  // The public demo has no SMTP egress (and no real recipients).
  if (isDemoMode()) {
    logger.info("[Demo] DEMO_MODE active — skipping contest email notification");
    return;
  }

  const recipients = notifyEmails();
  if (recipients.length === 0) {
    logger.warn("CONTEST_NOTIFY_EMAILS not configured — skipping contest email notification");
    return;
  }

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn("SMTP_USER or SMTP_PASS not configured — skipping contest email notification");
    return;
  }

  const rows: string[] = [];
  rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Title</td><td style="padding:6px 12px;">${contest.title}</td></tr>`);
  if (contest.objective) rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Objective</td><td style="padding:6px 12px;">${contest.objective}</td></tr>`);
  rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Metric</td><td style="padding:6px 12px;">${contest.metric}</td></tr>`);
  rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Period</td><td style="padding:6px 12px;">${contest.startDate} → ${contest.endDate}</td></tr>`);
  if (contest.product) rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Products</td><td style="padding:6px 12px;">${contest.product.split(",").join(", ")}</td></tr>`);
  if (contest.eligibility) rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Eligibility</td><td style="padding:6px 12px;">${contest.eligibility}</td></tr>`);
  if (contest.incentiveStructure) rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Incentive Structure</td><td style="padding:6px 12px;">${contest.incentiveStructure}</td></tr>`);
  if (contest.rewardDetails) rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Reward</td><td style="padding:6px 12px;">${contest.rewardDetails}</td></tr>`);
  rows.push(`<tr><td style="padding:6px 12px;font-weight:600;color:#64748b;">Created By</td><td style="padding:6px 12px;">${contest.createdByName}</td></tr>`);

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;">
      <div style="background:#006AFF;color:white;padding:16px 20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">🏆 New Sales Contest — Approval Needed</h2>
      </div>
      <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:20px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${rows.join("\n          ")}
        </table>
        <div style="margin-top:20px;padding:12px;background:#FEF3C7;border-radius:6px;font-size:13px;color:#92400E;">
          Log in to the <strong>Frontline Sales Dashboard → Sales Contests</strong> tab to approve or reject this contest.
        </div>
      </div>
    </div>
  `;

  const text = [
    `New Sales Contest Submitted for Approval`,
    ``,
    `Title: ${contest.title}`,
    contest.objective ? `Objective: ${contest.objective}` : null,
    `Metric: ${contest.metric}`,
    `Period: ${contest.startDate} → ${contest.endDate}`,
    contest.product ? `Products: ${contest.product.split(",").join(", ")}` : null,
    contest.eligibility ? `Eligibility: ${contest.eligibility}` : null,
    contest.incentiveStructure ? `Incentive Structure: ${contest.incentiveStructure}` : null,
    contest.rewardDetails ? `Reward: ${contest.rewardDetails}` : null,
    `Created By: ${contest.createdByName}`,
    ``,
    `Log in to the Frontline Sales Dashboard → Sales Contests tab to approve.`,
  ].filter(Boolean).join("\n");

  try {
    await transporter.sendMail({
      from: `"Frontline Sales Dashboard" <${process.env.SMTP_USER}>`,
      to: recipients.join(", "),
      subject: `Contest Approval Needed: ${contest.title}`,
      text,
      html,
    });
    logger.info({ contest: contest.title, to: recipients }, "Sent contest notification email");
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to send contest notification email"
    );
  }
}
