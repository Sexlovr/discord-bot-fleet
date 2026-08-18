// Validate a Discord bot token — returns bot user info if valid.

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { Client, GatewayIntentBits } from 'discord.js';

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { token } = await req.json();
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = new Promise<{ tag: string; id: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('login timeout')), 15000);
      client.once('ready', (c) => { clearTimeout(t); resolve({ tag: c.user.tag, id: c.user.id }); });
      client.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    await client.login(token);
    const { tag, id } = await ready;
    return NextResponse.json({ valid: true, bot_tag: tag, bot_id: id });
  } catch (e) {
    return NextResponse.json({ valid: false, error: (e as Error).message });
  } finally {
    client.destroy();
  }
}
