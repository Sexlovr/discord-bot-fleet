// Auth helper — checks session token from x-session-token header.

import { headers } from 'next/headers';
import { db } from '@/lib/db';

export async function requireAuth(): Promise<boolean> {
  const h = await headers();
  const token = h.get('x-session-token');
  if (!token) return false;
  const session = await db.session.findUnique({ where: { token } });
  if (!session) return false;
  if (session.expiresAt < new Date()) {
    await db.session.delete({ where: { id: session.id } }).catch(() => {});
    return false;
  }
  return true;
}
