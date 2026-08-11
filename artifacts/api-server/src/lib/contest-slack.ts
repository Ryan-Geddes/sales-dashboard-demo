import { getUncachableSlackClient } from "./slack-client";
import { logger } from "./logger";

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: { real_name?: string; display_name?: string };
  deleted?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const slackIdCache = new Map<string, string>();

async function findSlackUserId(name: string): Promise<string | null> {
  if (slackIdCache.has(name)) return slackIdCache.get(name)!;

  try {
    const client = await getUncachableSlackClient();
    let cursor: string | undefined;
    let page = 0;
    const lowerName = name.toLowerCase();

    do {
      if (page > 0) await sleep(3000);
      const result = await client.users.list({ limit: 200, cursor });
      const members = (result.members || []) as SlackUser[];
      cursor = result.response_metadata?.next_cursor || undefined;
      page++;

      for (const u of members) {
        if (u.deleted) continue;
        const realName = (u.profile?.real_name || u.real_name || "").toLowerCase();
        const displayName = (u.profile?.display_name || "").toLowerCase();
        if (realName === lowerName || displayName === lowerName) {
          slackIdCache.set(name, u.id);
          return u.id;
        }
      }

      if (page > 50) break;
    } while (cursor);
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, `Failed to find Slack user: ${name}`);
  }

  return null;
}

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
  try {
    // Approvers who get the contest DM, from the comma-separated
    // SLACK_NOTIFY_NAMES env var (Slack display / real names). No hard-coded
    // names so this repo can be public.
    const targetNames = (process.env.SLACK_NOTIFY_NAMES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (targetNames.length === 0) {
      logger.warn(
        "SLACK_NOTIFY_NAMES not configured — skipping contest Slack notification",
      );
      return;
    }
    const userIds: string[] = [];

    for (const name of targetNames) {
      const id = await findSlackUserId(name);
      if (id) userIds.push(id);
    }

    if (userIds.length === 0) {
      logger.warn("Could not find any target users in Slack for contest notification");
      return;
    }

    const client = await getUncachableSlackClient();
    const dmResult = await client.conversations.open({ users: userIds.join(",") });
    const channelId = dmResult.channel?.id;
    if (!channelId) {
      logger.warn("Could not open group DM for contest notification");
      return;
    }

    const lines: string[] = [
      `🏆 *New Sales Contest Submitted for Approval*\n`,
      `*Title:* ${contest.title}`,
    ];
    if (contest.objective) lines.push(`*Objective:* ${contest.objective}`);
    lines.push(`*Metric:* ${contest.metric}`);
    lines.push(`*Period:* ${contest.startDate} → ${contest.endDate}`);
    if (contest.product) lines.push(`*Products:* ${contest.product.split(",").join(", ")}`);
    if (contest.eligibility) lines.push(`*Eligibility:* ${contest.eligibility}`);
    if (contest.incentiveStructure) lines.push(`*Incentive Structure:* ${contest.incentiveStructure}`);
    if (contest.rewardDetails) lines.push(`*Reward:* ${contest.rewardDetails}`);
    lines.push(`*Created by:* ${contest.createdByName}`);
    lines.push(`\n_Log in to the Frontline Sales Dashboard → Sales Contests tab to approve._`);

    const message = lines.join("\n");

    await client.chat.postMessage({ channel: channelId, text: message });
    logger.info({ contest: contest.title }, "Sent contest notification to Slack");
  } catch (err: unknown) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to send contest Slack notification"
    );
  }
}
