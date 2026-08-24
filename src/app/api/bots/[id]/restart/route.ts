import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { restartBot } from '@/lib/bot';
import { pushNow } from '@/lib/hf-persist';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  try {
    await restartBot(id);
    await pushNow();
  return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
