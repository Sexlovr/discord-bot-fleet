// Simple file logger — writes to db/logs/<bot_id>.log as JSON lines.
// Used for the panel's "Live Logs" tab.

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'db', 'logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

export function writeLog(botId: string, level: string, msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    bot_id: botId,
    msg,
    ...(meta || {}),
  };
  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(join(LOG_DIR, `${botId}.log`), line);
  } catch { /* ignore */ }
  // Also print to console for Next.js dev log visibility
  if (level === 'error') console.error(`[${botId}] ${level}: ${msg}`, meta || '');
  else console.log(`[${botId}] ${level}: ${msg}`, meta || '');
}
