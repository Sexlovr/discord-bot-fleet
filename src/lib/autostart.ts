// Autostart module — wraps the bot autostart/orphan-check/auto-seed logic.
// Invoked once on Next.js startup via instrumentation.ts.

import { autostartBots, reapOrphanedBots, autoSeedBots } from './bot';
import { writeLog } from './logger';

let started = false;

export async function runAutostart(): Promise<void> {
  if (started) return; // idempotent
  started = true;
  try {
    writeLog('system', 'info', 'Autostart sweep starting');
    await reapOrphanedBots();
    await autoSeedBots();
    await autostartBots();
    writeLog('system', 'info', 'Autostart sweep complete');
  } catch (e) {
    writeLog('system', 'error', 'Autostart sweep failed', { error: (e as Error).message });
  }
}

// Re-export for convenience
export { autostartBots, reapOrphanedBots, autoSeedBots };
