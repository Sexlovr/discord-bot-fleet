// Type definitions shared across the bot fleet.

export interface ToolConfig {
  web_search: boolean;
  ping_proxy: boolean;
  fetch_url: boolean;
  github_lookup: boolean;
  memory: boolean;
  schedule_reminder: boolean;
  react_to_message: boolean;
}

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
  status: 'stopped' | 'running' | 'error';
  created_at: number;
  updated_at: number;
  llm: LLMConfig;
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
  max_tokens: 500,
};

export function makeDefaultBotConfig(partial: Partial<BotConfig>): Omit<BotConfig, 'id' | 'token_enc' | 'created_at' | 'updated_at' | 'status'> & Partial<Pick<BotConfig, 'id' | 'token_enc' | 'created_at' | 'updated_at' | 'status'>> {
  return {
    name: partial.name || 'New Bot',
    persona: partial.persona || 'You are a friendly Discord bot. Be concise and warm.',
    guild_id: partial.guild_id || '',
    channel_ids: partial.channel_ids || [],
    llm: { ...DEFAULT_LLM, ...partial.llm },
    gating: { ...DEFAULT_GATING, ...partial.gating },
    tools: { ...DEFAULT_TOOLS, ...partial.tools },
  };
}
