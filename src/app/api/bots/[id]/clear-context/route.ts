// POST /api/bots/:id/clear-context — clear in-memory chat history for a bot
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { clearBotContext } from '@/lib/bot';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  clearBotContext(id);
  return NextResponse.json({ ok: true });
}
