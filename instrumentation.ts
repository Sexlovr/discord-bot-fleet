// Next.js instrumentation — runs once on server startup.
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation

export async function register() {
  // Only run on the server (Node.js runtime), not on the edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runAutostart } = await import('./src/lib/autostart');
    // Fire-and-forget — don't block Next.js startup on autostart.
    runAutostart().catch((e) => {
      console.error('[autostart] failed:', e);
    });
  }
}
