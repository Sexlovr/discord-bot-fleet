// fetch_url — fetches a URL and returns sanitized text content.
// Strips HTML tags, limits to 5000 chars, no JavaScript execution.
// SSRF-protected: blocks private/internal IPs and cloud metadata endpoints.

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import type { LLMTool } from '../llm.js';

// Block private/reserved IP ranges to prevent SSRF attacks.
// Note: only blocks IPv4 for simplicity. IPv6 private ranges (fc00::/7, ::1) are also blocked.
function isPrivateHost(hostname: string): boolean {
  // Normalize: strip brackets from IPv6, lowercase
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Block common metadata endpoints
  if (host === 'metadata.google.internal' || host === '169.254.169.254' || host === 'metadata.azure.com') {
    return true;
  }
  if (host.endsWith('.internal') || host.endsWith('.local') || host === 'localhost') {
    return true;
  }

  // IPv4 check
  const ip = isIP(host);
  if (ip === 4) {
    const parts = host.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;                                  // 10.0.0.0/8
    if (a === 127) return true;                                 // 127.0.0.0/8 (loopback)
    if (a === 0) return true;                                    // 0.0.0.0/8
    if (a === 169 && b === 254) return true;                    // 169.254.0.0/16 (link-local, includes cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;         // 100.64.0.0/10 (CGNAT)
    if (parts.every(p => p === 0)) return true;                 // 0.0.0.0
    if (parts.every(p => p === 255)) return true;               // 255.255.255.255 (broadcast)
  }
  if (ip === 6) {
    // IPv6: block ::1, ::, fc00::/7, fe80::/10
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;  // fc00::/7 (ULA)
    if (host.startsWith('fe8') || host.startsWith('fe9') ||
        host.startsWith('fea') || host.startsWith('feb')) return true; // fe80::/10 (link-local)
  }
  return false;
}

// Async check: resolves hostname and checks if the resolved IP is private.
// This catches cases like "attacker.com" that resolves to 127.0.0.1.
async function isPrivateResolvableHost(hostname: string): Promise<boolean> {
  // If hostname is already an IP, check directly
  if (isIP(hostname) !== 0) return isPrivateHost(hostname);
  // Otherwise resolve and check
  try {
    const result = await lookup(hostname, { all: true });
    if (result.length === 0) return false; // will fail later in fetch
    return result.some(r => isPrivateHost(r.address));
  } catch {
    return false; // DNS failed — let fetch handle the error
  }
}

export const fetchUrlTool: LLMTool = {
  type: 'function',
  function: {
    name: 'fetch_url',
    description: 'Fetch a URL and return the text content (HTML stripped). Useful for reading articles, documentation, or API responses. Limited to 5000 chars. Cannot access private/internal IP ranges.',
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

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(args.url);
  } catch {
    return JSON.stringify({ error: `invalid URL: ${args.url}` });
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return JSON.stringify({ error: `only http/https allowed, got: ${parsedUrl.protocol}` });
  }

  // SSRF check — block private IPs and internal hostnames
  if (isPrivateHost(parsedUrl.hostname)) {
    return JSON.stringify({ error: `blocked: ${parsedUrl.hostname} is a private/internal address` });
  }
  if (await isPrivateResolvableHost(parsedUrl.hostname)) {
    return JSON.stringify({ error: `blocked: ${parsedUrl.hostname} resolves to a private IP` });
  }

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
