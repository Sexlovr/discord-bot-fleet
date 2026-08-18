// Type definitions shared across the bot fleet.

export interface ToolConfig {
  web_search: boolean;
  ping_proxy: boolean;
  fetch_url: boolean;
  github_lookup: boolean;
  memory: boolean;
  schedule_reminder: boolean;
  react_to_message: boolean;
  summon_bot: boolean; // bot-to-bot delegation
}

// ─── Multi-provider LLM support ──────────────────────────────────────────
// A bot can have multiple LLM providers. They're tried in priority order
// (lower priority = tried first). If a provider fails (timeout, 5xx, network
// error), the next one is tried. This way if your primary proxy is down,
// the bot automatically falls back to z.ai SDK or another proxy.
//
// Provider types:
//   - 'openai'    : OpenAI-compatible REST API (your lolmaobruhhh proxy, OpenAI, etc.)
//   - 'zai'       : z.ai SDK (uses z-ai-web-dev-sdk, no API key needed)
//
// For 'openai' providers: fill proxy_url + api_key_enc + model + temperature + max_tokens
// For 'zai' providers: only model + temperature + max_tokens needed
//                    (proxy_url + api_key are ignored, SDK handles auth internally)
//                    Optional: zai_thinking = 'enabled' | 'disabled' (chain-of-thought)

export type ProviderType = 'openai' | 'zai';

export interface LLMProvider {
  id: string;          // nanoid, used as identifier
  name: string;        // display name (e.g. "Primary proxy", "z.ai fallback")
  type: ProviderType;
  priority: number;    // 1 = highest priority (tried first), 2 = next, etc.
  enabled: boolean;    // can be toggled off without deleting

  // OpenAI-compatible fields (ignored for 'zai' type)
  proxy_url: string;
  api_key_enc: string; // encrypted (empty for 'zai' type)
  model: string;
  temperature: number;
  max_tokens: number;

  // z.ai-specific (ignored for 'openai' type)
  zai_thinking?: 'enabled' | 'disabled';  // chain-of-thought, default 'disabled'
}

// Backward-compat: a single LLMConfig (old format) is auto-converted to a
// single-provider list at runtime. New bots always use providers[].
export interface LLMConfig {
  proxy_url: string;
  api_key_enc: string; // encrypted
  model: string;
  temperature: number;
  max_tokens: number;
}

export interface GatingConfig {
  response_probability: number; // 0..1 — chance to respond when message passes filters
  skip_patterns: string[];       // regexes; if message matches, skip
  ignore_bots: boolean;          // don't respond to other bots
  ignore_own_messages: boolean;  // always true, can't be turned off
  max_context_messages: number;  // how many prior messages to feed the LLM
  cooldown_ms: number;           // min time between this bot's replies
}

export interface BotConfig {
  id: string;          // nanoid, used as the --id argument
  name: string;        // display name (e.g. "Mama")
  persona: string;     // system prompt
  token_enc: string;   // encrypted Discord bot token
  guild_id: string;   // Discord server ID
  channel_ids: string[]; // channels where bot is active (empty = all visible)
  discord_user_id?: string; // populated after first login (cached, not secret)
  delegated_bots: string[]; // IDs of other bots in the fleet this bot can summon
  status: 'stopped' | 'running' | 'error';
  created_at: number;
  updated_at: number;
  llm: LLMConfig;        // backward compat — single provider config
  providers?: LLMProvider[]; // new multi-provider list (preferred over llm)
  gating: GatingConfig;
  tools: ToolConfig;
}

export const DEFAULT_TOOLS: ToolConfig = {
  web_search: true,
  ping_proxy: true,
  fetch_url: true,
  github_lookup: true,
  memory: true,
  schedule_reminder: true,
  react_to_message: true,
  summon_bot: false, // off by default — enable per-bot when delegation is set up
};

export const DEFAULT_GATING: GatingConfig = {
  response_probability: 0.7,
  skip_patterns: ['^lol$', '^\\+$', '^-$', '^lmao$', '^(ok|okay|k)$'],
  ignore_bots: true,
  ignore_own_messages: true,
  max_context_messages: 30,
  cooldown_ms: 2000,
};

export const DEFAULT_LLM: LLMConfig = {
  proxy_url: 'https://lolmaobruhhh-fap.hf.space/v1',
  api_key_enc: '', // filled at runtime from env LLM_API_KEY if empty
  model: 'gemini-3.6-flash-high-search',
  temperature: 0.8,
  max_tokens: 1500, // bumped from 500 — 500 was cutting off replies
};

// Build the default single-provider list from a legacy LLMConfig.
// Used when a bot has `llm` set but no `providers[]`.
export function providersFromLegacy(llm: LLMConfig): LLMProvider[] {
  return [{
    id: 'default',
    name: 'Default',
    type: 'openai',
    priority: 1,
    enabled: true,
    proxy_url: llm.proxy_url,
    api_key_enc: llm.api_key_enc,
    model: llm.model,
    temperature: llm.temperature,
    max_tokens: llm.max_tokens,
  }];
}

// z.ai SDK provider preset — useful as a free fallback
export function makeZaiProvider(priority: number, model = 'glm-4.6', max_tokens = 1500): LLMProvider {
  return {
    id: `zai-${priority}`,
    name: `z.ai SDK (model: ${model})`,
    type: 'zai',
    priority,
    enabled: true,
    proxy_url: '',
    api_key_enc: '',
    model,
    temperature: 0.8,
    max_tokens,
    zai_thinking: 'disabled',
  };
}

export function makeDefaultBotConfig(partial: Partial<BotConfig>): Omit<BotConfig, 'id' | 'token_enc' | 'created_at' | 'updated_at' | 'status'> & Partial<Pick<BotConfig, 'id' | 'token_enc' | 'created_at' | 'updated_at' | 'status'>> {
  return {
    name: partial.name || 'New Bot',
    persona: partial.persona || 'You are a friendly Discord bot. Be concise and warm.',
    guild_id: partial.guild_id || '',
    channel_ids: partial.channel_ids || [],
    delegated_bots: partial.delegated_bots || [],
    llm: { ...DEFAULT_LLM, ...partial.llm },
    providers: partial.providers, // undefined = use legacy llm
    gating: { ...DEFAULT_GATING, ...partial.gating },
    tools: { ...DEFAULT_TOOLS, ...partial.tools },
  };
}
