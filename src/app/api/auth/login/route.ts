// Login — password from ADMIN_PASSWORD env var, session stored in DB.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ADMIN_PASSWORD } from '@/lib/env';
import { randomBytes } from 'crypto';

export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const adminPw = ADMIN_PASSWORD;
  if (!adminPw) {
    return NextResponse.json({ error: 'ADMIN_PASSWORD env not set. Set it in your .env file.' }, { status: 500 });
  }
  if (password !== adminPw) {
    return NextResponse.json({ error: 'invalid password' }, { status: 401 });
  }
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.session.create({ data: { token, expiresAt } });
  await db.auditLog.create({ data: { action: 'login' } });
  return NextResponse.json({ token, expires_in: 86400 });
}
