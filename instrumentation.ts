// Next.js instrumentation — runs once on server startup.
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
//
// On startup: pull the SQLite DB from HF Storage Bucket before the app
// starts serving requests. This ensures Prisma sees the latest DB state.
// On shutdown: flush a final DB push so no writes are lost.

export async function register() {
  // Only run on the server (Node.js runtime), not on the edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { pullDbFromHf, flushNow, isHfPersistEnabled } = await import('./src/lib/hf-persist');

    if (isHfPersistEnabled()) {
      console.log('[instrumentation] HF persistence is enabled — pulling DB from bucket...');
      try {
        const result = await pullDbFromHf();
        if (result.ok) {
          console.log(`[instrumentation] DB pull OK — ${result.bytes} bytes${result.fresh ? ' (fresh start — bucket was empty)' : ''}`);
        } else {
          console.warn('[instrumentation] DB pull failed — continuing with whatever local DB exists');
        }
      } catch (e) {
        console.error('[instrumentation] DB pull error:', e);
      }
    } else {
      console.log('[instrumentation] HF persistence is disabled (HF_TOKEN or HF_BUCKET not set)');
    }

    // Register shutdown hooks — flush one final DB push
    const flushAndExit = async (signal: string) => {
      console.log(`[instrumentation] received ${signal} — flushing DB to HF...`);
      try {
        await flushNow();
        console.log('[instrumentation] flush complete');
      } catch (e) {
        console.error('[instrumentation] flush error:', e);
      }
      // Give the process a moment to finish writing logs, then exit
      setTimeout(() => process.exit(0), 200);
    };
    process.on('SIGTERM', () => flushAndExit('SIGTERM'));
    process.on('SIGINT', () => flushAndExit('SIGINT'));

    // Fire-and-forget the autostart sweep — don't block Next.js startup
    const { runAutostart } = await import('./src/lib/autostart');
    runAutostart().catch((e) => {
      console.error('[autostart] failed:', e);
    });
  }
}
