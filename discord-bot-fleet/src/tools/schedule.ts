// schedule_reminder — fire-and-forget reminders using node-cron.
// Reminders fire as Discord messages from this bot to a target channel.

import cron from 'node-cron';
import type { LLMTool } from '../llm.js';
import type { ToolContext } from './index.js';

// In-process scheduler (resets on restart — acceptable for v1).
const scheduledJobs = new Map<string, cron.ScheduledTask>();

function parseDelayToCron(delay: string): { cron: string; oneShot: boolean } | null {
  // Supported formats: "5m", "30m", "1h", "2h", "1d", or a cron expression
  const m = delay.match(/^(\d+)([smhd])$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 's' && n >= 30) {
      // seconds -> convert to cron "*/n * * * * *" but node-cron doesn't support seconds reliably; use setTimeout instead
      return null;
    }
    if (unit === 'm') return { cron: `*/${n} * * * *`, oneShot: true };
    if (unit === 'h') return { cron: `0 */${n} * * *`, oneShot: true };
    if (unit === 'd') return { cron: `0 0 */${n} * *`, oneShot: true };
  }
  // Try as a cron expression
  if (cron.validate(delay)) {
    return { cron: delay, oneShot: false };
  }
  return null;
}

export const scheduleReminderTool: LLMTool = {
  type: 'function',
  function: {
    name: 'schedule_reminder',
    description: 'Schedule a future reminder that posts a message to a channel. Useful for "remind me in 1 hour" or scheduled pings. Delay can be "30m", "1h", "2h", "1d", or a cron expression like "0 9 * * *".',
    parameters: {
      type: 'object',
      properties: {
        delay: { type: 'string', description: 'Time until reminder fires. Format: "30m" / "1h" / "2h" / "1d", or a cron expression like "0 9 * * *".' },
        message: { type: 'string', description: 'Message content to post when the reminder fires.' },
        channel_id: { type: 'string', description: 'Discord channel ID to post in. If omitted, uses the channel the conversation is happening in.' },
      },
      required: ['delay', 'message'],
    },
  },
};

export async function scheduleReminderHandler(
  args: { delay: string; message: string; channel_id?: string },
  ctx: ToolContext
): Promise<string> {
  const parsed = parseDelayToCron(args.delay);
  if (!parsed) {
    return JSON.stringify({ error: `invalid delay "${args.delay}". Use "30m", "1h", "2h", "1d", or a cron expression.` });
  }
  const channelId = args.channel_id || ctx.botConfig.channel_ids[0];
  if (!channelId) {
    return JSON.stringify({ error: 'no channel_id provided and bot has no default channel configured' });
  }
  const jobId = `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const task = cron.schedule(parsed.cron, async () => {
    try {
      await ctx.sendChannelMessage(channelId, args.message);
    } catch (e) {
      console.error('[schedule] failed to send reminder:', e);
    }
    if (parsed.oneShot) {
      task.stop();
      scheduledJobs.delete(jobId);
    }
  });
  scheduledJobs.set(jobId, task);
  return JSON.stringify({ ok: true, job_id: jobId, fires_at_cron: parsed.cron, one_shot: parsed.oneShot });
}
