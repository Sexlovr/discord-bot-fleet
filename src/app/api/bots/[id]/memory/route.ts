// View bot's persistent memory

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MEMORY_DIR = join(process.cwd(), 'db', 'memory');

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const file = join(MEMORY_DIR, `${id}.json`);
  if (!existsSync(file)) return NextResponse.json({ memory: {} });
  try {
    const mem = JSON.parse(readFileSync(file, 'utf8'));
    return NextResponse.json({ memory: mem });
  } catch {
    return NextResponse.json({ memory: {} });
  }
}
