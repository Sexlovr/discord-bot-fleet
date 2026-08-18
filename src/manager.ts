// Bot Manager — spawns/kills bot child processes, exposes status, streams logs.
// Each bot is a child process: node dist/bot.js --id=<bot_id>

import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getBot, listBots, setBotStatus, updateBot } from './store.js';
import { getBotLogger, getLogBus } from './logger.js';
import type { BotConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BOT_SCRIPT = join(__dirname, '..', 'bot-python', 'bot.py'); // Python runtime (HF Space can't reach Discord WS from Node)

class BotManager {
  private processes = new Map<string, ChildProcess>();
  private startupPromise = new Map<string, Promise<void>>();

  isRunning(botId: string): boolean {
    return this.processes.has(botId) && !this.processes.get(botId)!.killed;
  }

  async start(botId: string): Promise<void> {
    if (this.isRunning(botId)) {
      throw new Error(`bot ${botId} is already running`);
    }
    const config = getBot(botId);
    if (!config) throw new Error(`bot ${botId} not found`);
    if (!config.token_enc) throw new Error(`bot ${botId} has no token configured`);

    const log = getBotLogger(botId);
    log.info('Starting bot process', { script: BOT_SCRIPT });

    const child = spawn('python3', [BOT_SCRIPT, `--id=${botId}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // If still alive after 15s, consider it "started" (Discord login can take time)
        if (!child.killed) {
          resolve();
        }
      }, 15000);

      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        this.processes.delete(botId);
        this.startupPromise.delete(botId);
        log.info('Bot process exited', { code, signal });
        setBotStatus(botId, code === 0 ? 'stopped' : 'error');
        resolve();
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        log.error('Bot process error', { error: err.message });
        this.processes.delete(botId);
        this.startupPromise.delete(botId);
        setBotStatus(botId, 'error');
        reject(err);
      });

      // Pipe stdout/stderr to logger
      child.stdout?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.info(line);
      });
      child.stderr?.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) log.error(line);
      });
    });

    this.processes.set(botId, child);
    this.startupPromise.set(botId, promise);
    setBotStatus(botId, 'running');
    return promise;
  }

  async stop(botId: string, timeoutMs = 5000): Promise<void> {
    const child = this.processes.get(botId);
    if (!child) {
      setBotStatus(botId, 'stopped');
      return;
    }
    const log = getBotLogger(botId);
    log.info('Stopping bot process (SIGTERM)');
    child.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!child.killed) {
          log.warn('Bot did not exit on SIGTERM, sending SIGKILL');
          child.kill('SIGKILL');
        }
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    this.processes.delete(botId);
    setBotStatus(botId, 'stopped');
  }

  async restart(botId: string): Promise<void> {
    await this.stop(botId);
    await this.start(botId);
  }

  // Start all bots that were running before restart (persisted status)
  async autostart(): Promise<void> {
    const bots = listBots();
    for (const bot of bots) {
      if (bot.status === 'running') {
        try {
          await this.start(bot.id);
        } catch (e) {
          getBotLogger(bot.id).error('Autostart failed', { error: (e as Error).message });
        }
      }
    }
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.processes.keys());
    await Promise.all(ids.map(id => this.stop(id)));
  }

  getStatus(botId: string): { running: boolean; pid?: number } {
    const child = this.processes.get(botId);
    return {
      running: !!child && !child.killed,
      pid: child?.pid,
    };
  }

  getAllStatuses(): Array<{ id: string; name: string; running: boolean; pid?: number }> {
    return listBots().map(b => ({
      id: b.id,
      name: b.name,
      ...this.getStatus(b.id),
    }));
  }
}

const manager = new BotManager();
export function getBotManager() { return manager; }
export { BotManager };
