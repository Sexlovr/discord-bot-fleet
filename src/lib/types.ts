// Types shared across the bot fleet.
// Matches the Python bot-python/types.py + the legacy Node implementation.

export interface LLMProvider {
  id: string;
  name: string;
  type: 'openai' | 'zai';
  priority: number;
  enabled: boolean;

  // OpenAI-compatible fields (ignored for 'zai' type)
  proxy_url: string;
  api_key_enc: string;
  model: string;
  temperature: number;
  max_tokens: number;

  // z.ai-specific (ignored for 'openai' type)
  zai_thinking?: 'enabled' | 'disabled';
}

export interface BotConfig {
  id: string;
  name: string;
  persona: string;
  token_enc: string;
  guild_id: string;
  channel_ids: string[];
  discord_user_id?: string;
  delegated_bots: string[];
  status: 'stopped' | 'running' | 'error';
  created_at: number;
  updated_at: number;

  // Multi-provider LLM (preferred)
  providers: LLMProvider[];

  // Legacy single-provider config (used if providers[] is empty)
  llm: {
    proxy_url: string;
    api_key_enc: string;
    model: string;
    temperature: number;
    max_tokens: number;
  };

  gating: {
    response_probability: number;
    skip_patterns: string[];
    ignore_bots: boolean;
    ignore_own_messages: boolean;
    max_context_messages: number;
    cooldown_ms: number;
    response_delay_ms: number;
  };

  tools: {
    web_search: boolean;
    ping_proxy: boolean;
    fetch_url: boolean;
    github_lookup: boolean;
    memory: boolean;
    schedule_reminder: boolean;
    react_to_message: boolean;
    summon_bot: boolean;
  };
}

// Convert a Prisma Bot row to a BotConfig
import type { Bot as PrismaBot } from '@prisma/client';
import { decryptString, maskToken } from './crypto';

export function prismaBotToConfig(b: PrismaBot): BotConfig {
  let channelIds: string[] = [];
  let delegatedBots: string[] = [];
  let skipPatterns: string[] = [];
  let providers: LLMProvider[] = [];

  try { channelIds = JSON.parse(b.channelIds || '[]'); } catch {}
  try { delegatedBots = JSON.parse(b.delegatedBots || '[]'); } catch {}
  try { skipPatterns = JSON.parse(b.skipPatterns || '[]'); } catch {}
  try { providers = JSON.parse(b.providers || '[]'); } catch {}

  return {
    id: b.id,
    name: b.name,
    persona: b.persona,
    token_enc: b.tokenEnc,
    guild_id: b.guildId,
    channel_ids: channelIds,
    discord_user_id: b.discordUserId || undefined,
    delegated_bots: delegatedBots,
    status: b.status as BotConfig['status'],
    created_at: b.createdAt.getTime(),
    updated_at: b.updatedAt.getTime(),
    providers,
    llm: {
      proxy_url: b.llmProxyUrl,
      api_key_enc: b.llmApiKeyEnc,
      model: b.llmModel,
      temperature: b.llmTemperature,
      max_tokens: b.llmMaxTokens,
    },
    gating: {
      response_probability: b.responseProbability,
      skip_patterns: skipPatterns,
      ignore_bots: b.ignoreBots,
      ignore_own_messages: true,
      max_context_messages: b.maxContextMessages,
      cooldown_ms: b.cooldownMs,
      response_delay_ms: (b as any).responseDelayMs ?? 0,
    },
    tools: {
      web_search: b.toolWebSearch,
      ping_proxy: b.toolPingProxy,
      fetch_url: b.toolFetchUrl,
      github_lookup: b.toolGithubLookup,
      memory: b.toolMemory,
      schedule_reminder: b.toolScheduleReminder,
      react_to_message: b.toolReactToMessage,
      summon_bot: b.toolSummonBot,
    },
  };
}

// Sanitize config for client (no secrets)
export function sanitizeBot(b: PrismaBot) {
  const config = prismaBotToConfig(b);
  const llmKeyEnc = config.llm.api_key_enc;
  return {
    ...config,
    token_enc: undefined,
    token_masked: config.token_enc ? maskTokenSafe(config.token_enc) : '',
    llm: {
      ...config.llm,
      api_key_enc: undefined,
      api_key_masked: llmKeyEnc ? 'set' : 'unset',
    },
    providers: config.providers.map(p => ({
      ...p,
      api_key_enc: undefined,
      api_key_masked: p.api_key_enc ? 'set' : 'unset',
    })),
  };
}

function maskTokenSafe(tokenEnc: string): string {
  if (!tokenEnc) return '';
  try {
    return maskToken(decryptString(tokenEnc));
  } catch {
    return '???';
  }
}
