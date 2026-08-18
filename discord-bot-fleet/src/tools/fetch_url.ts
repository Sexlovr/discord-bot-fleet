// fetch_url — fetches a URL and returns sanitized text content.
// Strips HTML tags, limits to 5000 chars, no JavaScript execution.

import type { LLMTool } from '../llm.js';

export const fetchUrlTool: LLMTool = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch a URL and return the text content (HTML stripped). Useful for reading articles, documentation, or API responses. Limited to 5000 chars.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        max_chars: { type: 'number', description: 'Max chars to return (default 5000, max 10000)' },
      },
      required: ['url'],
    },
  },
};

export async function fetchUrlHandler(args: { url: string; max_chars?: number }): Promise<string> {
  const maxChars = Math.min(args.max_chars || 5000, 10000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(args.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status} ${res.statusText}`, url: args.url });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    let text: string;
    if (ct.includes('application/json')) {
      text = body;
    } else if (ct.includes('text/html')) {
      // Strip tags, scripts, styles, decode basic entities
      text = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      text = body;
    }
    return text.slice(0, maxChars);
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e), url: args.url });
  } finally {
    clearTimeout(timeout);
  }
}
