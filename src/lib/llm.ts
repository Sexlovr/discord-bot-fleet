// Multi-provider LLM client with failover.
// Tries providers in priority order. If a provider fails, falls back to next.

import OpenAI from 'openai';
import { decryptString } from './crypto';
import type { LLMProvider } from './types';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface LLMTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: LLMMessage['tool_calls'];
  finish_reason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  provider_used: string;
  used_fallback?: boolean;
}

class LLMProviderError extends Error {}

class OpenAICompatProvider {
  name: string;
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMProvider) {
    this.name = config.name;
    let apiKey: string;
    if (config.api_key_enc) {
      apiKey = decryptString(config.api_key_enc);
    } else {
      apiKey = process.env.LLM_API_KEY || 'FAP!';
    }
    this.client = new OpenAI({ baseURL: config.proxy_url, apiKey });
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxTokens = config.max_tokens;
  }

  async chat(messages: LLMMessage[], tools: LLMTool[] = []): Promise<LLMResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools.length > 0) {
      params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    }
    const resp = await this.client.chat.completions.create(
      params as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
    );
    const choice = resp.choices[0];
    return {
      content: choice.message.content,
      tool_calls: choice.message.tool_calls as LLMMessage['tool_calls'] | undefined,
      finish_reason: choice.finish_reason,
      usage: resp.usage ? {
        prompt_tokens: resp.usage.prompt_tokens,
        completion_tokens: resp.usage.completion_tokens,
        total_tokens: resp.usage.total_tokens,
      } : undefined,
      provider_used: this.name,
    };
  }
}

class ZaiSdkProvider {
  name: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private thinking: 'enabled' | 'disabled';

  constructor(config: LLMProvider) {
    this.name = config.name;
    this.model = config.model;
    this.temperature = config.temperature;
    this.maxTokens = config.max_tokens;
    this.thinking = config.zai_thinking || 'disabled';
  }

  async chat(messages: LLMMessage[], _tools: LLMTool[] = []): Promise<LLMResponse> {
    // Use the z-ai-web-dev-sdk (server-side only)
    const ZAIModule = await import('z-ai-web-dev-sdk');
    const ZAI = ZAIModule.default;
    const zai = await ZAI.create();

    // z.ai SDK uses single-turn completions — we manage history ourselves
    // The SDK accepts a messages array similar to OpenAI but with 'thinking' option
    const completion = await zai.chat.completions.create({
      messages: messages as any,
      thinking: { type: this.thinking === 'enabled' ? 'enabled' : 'disabled' },
    } as any);

    const content = completion.choices?.[0]?.message?.content || '';
    return {
      content,
      tool_calls: undefined, // z.ai SDK doesn't expose tool_calls
      finish_reason: 'stop',
      usage: undefined,
      provider_used: this.name,
    };
  }
}

export class LLMClient {
  private providers: Array<OpenAICompatProvider | ZaiSdkProvider> = [];

  constructor(providers: LLMProvider[], legacyLlm?: {
    proxy_url: string;
    api_key_enc: string;
    model: string;
    temperature: number;
    max_tokens: number;
  }) {
    // If providers[] is empty and we have legacy llm config, convert it to a single-provider list
    let providerList = providers;
    if ((!providerList || providerList.length === 0) && legacyLlm) {
      providerList = [{
        id: 'default',
        name: 'Default',
        type: 'openai' as const,
        priority: 1,
        enabled: true,
        proxy_url: legacyLlm.proxy_url,
        api_key_enc: legacyLlm.api_key_enc,
        model: legacyLlm.model,
        temperature: legacyLlm.temperature,
        max_tokens: legacyLlm.max_tokens,
      }];
    }

    // Sort by priority
    providerList = [...providerList].sort((a, b) => a.priority - b.priority);

    for (const p of providerList) {
      if (!p.enabled) continue;
      if (p.type === 'openai') {
        this.providers.push(new OpenAICompatProvider(p));
      } else if (p.type === 'zai') {
        this.providers.push(new ZaiSdkProvider(p));
      }
    }

    if (this.providers.length === 0) {
      throw new LLMProviderError('No enabled LLM providers configured');
    }
  }

  async chat(messages: LLMMessage[], tools: LLMTool[] = []): Promise<LLMResponse> {
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      try {
        const resp = await provider.chat(messages, tools);
        if (i > 0) resp.used_fallback = true;
        return resp;
      } catch (e) {
        const err = e as Error;
        errors.push(`${provider.name}: ${err.message}`);
        // Try next provider
        continue;
      }
    }
    throw new LLMProviderError('All providers failed: ' + errors.join(' | '));
  }

  static async ping(proxyUrl: string, apiKey: string, model?: string): Promise<{
    status: 'online' | 'offline' | 'error';
    latency_ms?: number;
    models?: string[];
    test_response?: string;
    error?: string;
  }> {
    const start = Date.now();
    try {
      const client = new OpenAI({ baseURL: proxyUrl, apiKey });
      const modelsResp = await client.models.list();
      const models = Array.isArray(modelsResp.data) ? modelsResp.data.map(m => m.id) : [];
      let test_response: string | undefined;
      if (model) {
        const chat = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'Say "hello" in one word.' }],
          max_tokens: 10,
        });
        test_response = chat.choices[0]?.message?.content || '';
      }
      return {
        status: 'online',
        latency_ms: Date.now() - start,
        models,
        test_response,
      };
    } catch (e: unknown) {
      const err = e as Error;
      return {
        status: 'error',
        latency_ms: Date.now() - start,
        error: err.message || String(e),
      };
    }
  }
}
