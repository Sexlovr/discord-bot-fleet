// ping_ai_proxy — health-checks an OpenAI-compatible LLM proxy.
// Returns status, latency, available models, and a test response if a model is specified.

import type { LLMTool } from '../llm.js';
import { LLMClient } from '../llm.js';
import { decryptString } from '../crypto.js';

export const pingProxyTool: LLMTool = {
  type: 'function',
  function: {
    name: 'ping_ai_proxy',
    description: 'Health-check an OpenAI-compatible LLM proxy. Returns status, latency, available models, and optionally a test response. Useful for monitoring which proxies are alive.',
    parameters: {
      type: 'object',
      properties: {
        proxy_url: {
          type: 'string',
          description: 'Base URL of the OpenAI-compatible proxy, e.g. https://example.com/v1',
        },
        api_key: {
          type: 'string',
          description: 'API key for the proxy. Optional — falls back to the bot\'s configured key.',
        },
        model: {
          type: 'string',
          description: 'If provided, also sends a test "hello" message to this model and returns the response.',
        },
      },
      required: ['proxy_url'],
    },
  },
};

export async function pingProxyHandler(
  args: { proxy_url: string; api_key?: string; model?: string },
  ctx: { botConfig: { llm: { api_key_enc: string } } }
): Promise<string> {
  const apiKey = args.api_key || (ctx.botConfig.llm.api_key_enc ? decryptString(ctx.botConfig.llm.api_key_enc) : process.env.LLM_API_KEY || 'FAP!');
  const result = await LLMClient.ping(args.proxy_url, apiKey, args.model);
  return JSON.stringify(result);
}
