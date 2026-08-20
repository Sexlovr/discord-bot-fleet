// POST /api/bots/clear-all-context — clear ALL bots' chat history
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { clearAllContext } from '@/lib/bot';

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  clearAllContext();
  return NextResponse.json({ ok: true });
}
