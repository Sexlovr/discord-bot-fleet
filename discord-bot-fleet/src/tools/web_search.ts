// web_search — minimal web search via DuckDuckGo HTML endpoint.
// No API key required. Returns top 5 results with title/url/snippet.

import type { LLMTool } from '../llm.js';

export const webSearchTool: LLMTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current information. Returns up to 5 results with title, URL, and a short snippet. Use this when you need up-to-date info beyond your training data.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
};

export async function webSearchHandler(args: { query: string }): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)' },
    });
    if (!res.ok) return JSON.stringify({ error: `HTTP ${res.status}` });
    const html = await res.text();
    // Parse result blocks: <a class="result__a" href="...">title</a> + <a class="result__snippet">...</a>
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkRe = /<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snippetRe = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ url: string; title: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < 5) {
      // DDG wraps the URL in a redirect; extract the actual URL
      const raw = m[1];
      const u = raw.match(/uddg=([^&]+)/);
      const actualUrl = u ? decodeURIComponent(u[1]) : raw;
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      links.push({ url: actualUrl, title });
    }
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) && snippets.length < 5) {
      snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
    }
    for (let i = 0; i < links.length; i++) {
      results.push({ ...links[i], snippet: snippets[i] || '' });
    }
    if (results.length === 0) {
      return JSON.stringify({ error: 'no results found', query: args.query });
    }
    return JSON.stringify({ query: args.query, results });
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e) });
  } finally {
    clearTimeout(timeout);
  }
}
