// Bot CRUD endpoints.

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { encryptString } from '@/lib/crypto';
import { sanitizeBot } from '@/lib/types';
import { nanoid } from 'nanoid';

export async function GET() {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const bots = await db.bot.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ bots: bots.map(sanitizeBot) });
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json();
  const { name, persona, token, guild_id, channel_ids, delegated_bots, llm, providers, gating, tools } = body;
  if (!name || !persona || !token) {
    return NextResponse.json({ error: 'name, persona, and token are required' }, { status: 400 });
  }

  // Build providers list — encrypt api_key for any openai-type providers
  let providersJson = '[]';
  if (providers && Array.isArray(providers) && providers.length > 0) {
    const encryptedProviders = providers.map((p: any) => {
      const cleaned = { ...p };
      if (typeof cleaned.api_key === 'string') {
        cleaned.api_key_enc = cleaned.api_key ? encryptString(cleaned.api_key) : '';
        delete cleaned.api_key;
      }
      if (!cleaned.id) cleaned.id = nanoid(8);
      return cleaned;
    });
    providersJson = JSON.stringify(encryptedProviders);
  }

  const bot = await db.bot.create({
    data: {
      id: nanoid(10),
      name,
      persona,
      tokenEnc: encryptString(token),
      guildId: guild_id || '',
      channelIds: JSON.stringify(channel_ids || []),
      delegatedBots: JSON.stringify(delegated_bots || []),
      providers: providersJson,
      llmProxyUrl: llm?.proxy_url || 'https://lolmaobruhhh-fap.hf.space/v1',
      llmApiKeyEnc: llm?.api_key ? encryptString(llm.api_key) : '',
      llmModel: llm?.model || 'idk:gemini-3.6-flash-high-search',
      llmTemperature: llm?.temperature ?? 0.85,
      llmMaxTokens: llm?.max_tokens ?? 1500,
      responseProbability: gating?.response_probability ?? 1.0,
      skipPatterns: JSON.stringify(gating?.skip_patterns || ['^\\+$', '^-$', '^(k|kk)$']),
      ignoreBots: gating?.ignore_bots ?? true,
      maxContextMessages: gating?.max_context_messages ?? 30,
      cooldownMs: gating?.cooldown_ms ?? 1500,
      responseDelayMs: gating?.response_delay_ms ?? 0,
      toolWebSearch: tools?.web_search ?? true,
      toolPingProxy: tools?.ping_proxy ?? true,
      toolFetchUrl: tools?.fetch_url ?? true,
      toolGithubLookup: tools?.github_lookup ?? true,
      toolMemory: tools?.memory ?? true,
      toolScheduleReminder: tools?.schedule_reminder ?? true,
      toolReactToMessage: tools?.react_to_message ?? true,
      toolSummonBot: tools?.summon_bot ?? false,
      status: 'stopped',
    },
  });
  return NextResponse.json({ ok: true, bot: sanitizeBot(bot) });
}
