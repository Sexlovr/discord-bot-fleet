// GET /api/bots/:id/channels
// Auto-loads guilds + text channels for a bot using its stored token.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { decryptString } from '@/lib/crypto';
import { Client, GatewayIntentBits } from 'discord.js';

interface GuildInfo {
  id: string;
  name: string;
  icon: string | null;
  text_channels: Array<{ id: string; name: string; topic?: string | null }>;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const bot = await db.bot.findUnique({ where: { id } });
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let token: string;
  try {
    token = decryptString(bot.tokenEnc);
  } catch {
    return NextResponse.json({ error: 'failed to decrypt stored token' }, { status: 500 });
  }
  if (!token) return NextResponse.json({ error: 'no token stored' }, { status: 400 });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('login timeout')), 15000);
      client.once('ready', () => { clearTimeout(t); resolve(); });
      client.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    await client.login(token);
    await ready;
    await new Promise(r => setTimeout(r, 1500));
    const guilds: GuildInfo[] = [];
    for (const [, guild] of client.guilds.cache) {
      let channels: GuildInfo['text_channels'] = [];
      try {
        const fetched = await guild.channels.fetch();
        channels = fetched
          .filter(c => c && c.type === 0)
          .map(c => ({ id: c!.id, name: c!.name, topic: (c as { topic?: string | null }).topic }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch { /* skip */ }
      guilds.push({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL(),
        text_channels: channels,
      });
    }
    return NextResponse.json({ guilds });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  } finally {
    client.destroy();
  }
}
