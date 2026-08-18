// OpenAI-compatible LLM client. Works with your proxy (lolmaobruhhh-fap.hf.space/v1, FAP!).
// Supports tool calling via the standard OpenAI function-calling protocol.

import OpenAI from 'openai';
import type { BotConfig } from './types.js';
import { decryptString } from './crypto.js';

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
    parameters: Record<string, unknown>; // JSON schema
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: LLMMessage['tool_calls'];
  finish_reason: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: BotConfig) {
    // Decrypt API key. If empty, fall back to LLM_API_KEY env var (HF Secret).
    let apiKey: string;
    if (config.llm.api_key_enc) {
      apiKey = decryptString(config.llm.api_key_enc);
    } else {
      apiKey = process.env.LLM_API_KEY || 'FAP!';
    }

    this.client = new OpenAI({
      baseURL: config.llm.proxy_url,
      apiKey,
    });
    this.model = config.llm.model;
    this.temperature = config.llm.temperature;
    this.maxTokens = config.llm.max_tokens;
  }

  async chat(
    messages: LLMMessage[],
    tools: LLMTool[] = [],
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    const params: Record<string, unknown> = {
      model: this.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };
    if (tools.length > 0) {
      params.tools = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    }
    if (signal) params.signal = signal;

    const resp = await this.client.chat.completions.create(params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
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
    };
  }

  // Test the proxy: simple "hello" request, returns latency and model list
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
