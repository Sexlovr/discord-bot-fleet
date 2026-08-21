// POST /api/bots/stop-all — emergency stop for ALL running bots.
// Calls stopBot() on every bot currently tracked in the in-process Map.
// Also bumps every bot's activeClientId so any HMR-orphaned message handlers
// (in any module instance) self-silence immediately.
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { stopAllBots, listRunningBots } from '@/lib/bot';

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const before = listRunningBots();
  await stopAllBots();
  return NextResponse.json({ ok: true, stopped: before.length, ids: before });
}
