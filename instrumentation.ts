// Next.js instrumentation — runs once on server startup.
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation
//
// On startup: pull the SQLite DB from HF dataset repo before the app
// starts serving requests. This ensures Prisma sees the latest DB state.
// On shutdown: flush a final DB push so no writes are lost.

export async function register() {
  // Only run on the server (Node.js runtime), not on the edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { pullDbFromHf, flushNow, isHfPersistEnabled, markPullCompleted } = await import('./src/lib/hf-persist');

    if (isHfPersistEnabled()) {
      console.log('[instrumentation] HF persistence is enabled — pulling DB from dataset repo...');
      try {
        const result = await pullDbFromHf();
        if (result.ok) {
          console.log(`[instrumentation] DB pull OK — ${result.bytes} bytes${result.fresh ? ' (fresh start — repo was empty)' : ''}`);
          // CRITICAL: mark pull as completed so schedulePush() will actually push.
          // Without this, pushes are blocked to prevent the "empty DB wipes bucket" bug.
          markPullCompleted();
          // If this was a fresh start (repo was empty), do an immediate push to
          // seed the repo with the current local DB schema.
          if (result.fresh) {
            const { schedulePush } = await import('./src/lib/hf-persist');
            schedulePush(1000); // push after 1 second
          }
        } else {
          console.warn('[instrumentation] DB pull failed — continuing with whatever local DB exists');
          // Even on pull failure, mark pull completed so the app can still push
          // (otherwise the app would never persist any state).
          markPullCompleted();
        }
      } catch (e) {
        console.error('[instrumentation] DB pull error:', e);
        markPullCompleted(); // unblock pushes even on error
      }
    } else {
      console.log('[instrumentation] HF persistence is disabled (HF_TOKEN or HF_DATASET_REPO not set)');
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
