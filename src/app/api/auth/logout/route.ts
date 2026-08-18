import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { randomBytes } from 'crypto';

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-session-token') || '';
  if (token) {
    await db.session.deleteMany({ where: { token } }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
