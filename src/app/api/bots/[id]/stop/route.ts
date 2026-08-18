import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { stopBot } from '@/lib/bot';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  await stopBot(id).catch(() => {});
  return NextResponse.json({ ok: true });
}
