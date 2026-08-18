// Per-bot logger. Writes to data/logs/<bot_id>.log and emits to subscribers (web UI).

import { createReadStream, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { createInterface } from 'readline';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const LOG_DIR = join(DATA_DIR, 'logs');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class BotLogger {
  private botId: string;
  private logFile: string;
  static bus = new EventEmitter();

  constructor(botId: string) {
    this.botId = botId;
    this.logFile = join(LOG_DIR, `${botId}.log`);
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, bot_id: this.botId, msg, ...(meta || {}) }) + '\n';
    appendFileSync(this.logFile, line);
    BotLogger.bus.emit('log', { ts, level, bot_id: this.botId, msg, ...(meta || {}) });
  }

  debug(msg: string, meta?: Record<string, unknown>) { this.write('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.write('error', msg, meta); }
}

export function getBotLogger(botId: string) {
  return new BotLogger(botId);
}

export function getLogBus() {
  return BotLogger.bus;
}

export async function readRecentLogs(botId: string, lines = 200): Promise<string[]> {
  const file = join(LOG_DIR, `${botId}.log`);
  if (!existsSync(file)) return [];
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const all: string[] = [];
  for await (const line of rl) all.push(line);
  return all.slice(-lines);
}
