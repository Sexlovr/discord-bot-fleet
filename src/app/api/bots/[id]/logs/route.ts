// Get recent logs for a bot

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'db', 'logs');

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const lines = parseInt(url.searchParams.get('lines') || '200', 10);
  const file = join(LOG_DIR, `${id}.log`);
  if (!existsSync(file)) return NextResponse.json({ logs: [] });
  const content = readFileSync(file, 'utf8');
  const allLines = content.split('\n').filter(Boolean);
  return NextResponse.json({ logs: allLines.slice(-lines) });
}
