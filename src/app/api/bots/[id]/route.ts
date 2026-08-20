// GET /api/bots/:id  — get bot config
// PUT /api/bots/:id  — update bot config
// DELETE /api/bots/:id — delete bot

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import { encryptString, decryptString, maskToken } from '@/lib/crypto';
import { sanitizeBot } from '@/lib/types';
import { stopBot } from '@/lib/bot';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const bot = await db.bot.findUnique({ where: { id } });
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(sanitizeBot(bot));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  const bot = await db.bot.findUnique({ where: { id } });
  if (!bot) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const body = await req.json();
  const patch: Record<string, unknown> = { ...body };

  // Token rotation
  if (typeof patch.token === 'string') {
    patch.tokenEnc = encryptString(patch.token);
    delete patch.token;
  }

  // guild_id → guildId
  if (typeof patch.guild_id === 'string') {
    patch.guildId = patch.guild_id;
    delete patch.guild_id;
  }

  // Legacy LLM config — flatten any provided fields
  if (patch.llm && typeof patch.llm === 'object') {
    const llmPatch = patch.llm as any;
    if (llmPatch.proxy_url !== undefined) patch.llmProxyUrl = llmPatch.proxy_url;
    if (llmPatch.model !== undefined) patch.llmModel = llmPatch.model;
    if (llmPatch.temperature !== undefined) patch.llmTemperature = llmPatch.temperature;
    if (llmPatch.max_tokens !== undefined) patch.llmMaxTokens = llmPatch.max_tokens;
    if (typeof llmPatch.api_key === 'string') {
      patch.llmApiKeyEnc = llmPatch.api_key ? encryptString(llmPatch.api_key) : '';
    }
    delete patch.llm;
  }

  // Multi-provider encryption
  if (patch.providers && Array.isArray(patch.providers)) {
    const existingById = new Map((JSON.parse(bot.providers || '[]') as any[]).map(p => [p.id, p]));
    const newProviders = patch.providers.map((p: any) => {
      const existing = existingById.get(p.id) || {};
      const merged = { ...existing, ...p };
      if (typeof merged.api_key === 'string') {
        merged.api_key_enc = merged.api_key ? encryptString(merged.api_key) : '';
        delete merged.api_key;
      }
      return merged;
    });
    patch.providers = JSON.stringify(newProviders);
  }

  // channel_ids / delegated_bots / skip_patterns → JSON-encode, then DELETE the snake_case key
  if (Array.isArray(patch.channel_ids)) {
    patch.channelIds = JSON.stringify(patch.channel_ids);
    delete patch.channel_ids;
  }
  if (Array.isArray(patch.delegated_bots)) {
    patch.delegatedBots = JSON.stringify(patch.delegated_bots);
    delete patch.delegated_bots;
  }
  if (Array.isArray(patch.skip_patterns)) {
    patch.skipPatterns = JSON.stringify(patch.skip_patterns);
    delete patch.skip_patterns;
  }

  // Flatten gating.* fields
  if (patch.gating) {
    const g = patch.gating as any;
    if (g.response_probability !== undefined) patch.responseProbability = g.response_probability;
    if (Array.isArray(g.skip_patterns)) patch.skipPatterns = JSON.stringify(g.skip_patterns);
    if (g.ignore_bots !== undefined) patch.ignoreBots = g.ignore_bots;
    if (g.max_context_messages !== undefined) patch.maxContextMessages = g.max_context_messages;
    if (g.cooldown_ms !== undefined) patch.cooldownMs = g.cooldown_ms;
    if (g.response_delay_ms !== undefined) patch.responseDelayMs = g.response_delay_ms;
    delete patch.gating;
  }

  // Flatten tools.* fields
  if (patch.tools) {
    const t = patch.tools as any;
    const colMap: Record<string, string> = {
      web_search: 'toolWebSearch',
      ping_proxy: 'toolPingProxy',
      fetch_url: 'toolFetchUrl',
      github_lookup: 'toolGithubLookup',
      memory: 'toolMemory',
      schedule_reminder: 'toolScheduleReminder',
      react_to_message: 'toolReactToMessage',
      summon_bot: 'toolSummonBot',
    };
    for (const [k, v] of Object.entries(t)) {
      if (colMap[k]) patch[colMap[k]] = v;
    }
    delete patch.tools;
  }

  // Never let user patch these directly
  delete patch.id;
  delete patch.createdAt;
  delete patch.updatedAt;
  delete patch.status;
  delete patch.token_masked;
  delete patch.discord_user_id;
  delete patch.providers_public; // legacy guard

  const updated = await db.bot.update({ where: { id }, data: patch as any });
  return NextResponse.json(sanitizeBot(updated));
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const { id } = await params;
  await stopBot(id).catch(() => {});
  await db.bot.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
