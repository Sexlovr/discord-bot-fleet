// github_lookup — read-only GitHub repo metadata via the public API.

import type { LLMTool } from '../llm.js';

export const githubLookupTool: LLMTool = {
  type: 'function',
  function: {
    name: 'github_lookup',
    description: 'Look up a GitHub repo\'s metadata, README, or recent commits. Read-only, no authentication required (uses public API rate limits).',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repo owner (e.g. "facebook")' },
        repo:  { type: 'string', description: 'Repo name (e.g. "react")' },
        kind:  { type: 'string', enum: ['info', 'readme', 'commits'], description: 'What to fetch: repo info, README content, or recent commits' },
      },
      required: ['owner', 'repo', 'kind'],
    },
  },
};

export async function githubLookupHandler(args: {
  owner: string; repo: string; kind: 'info' | 'readme' | 'commits';
}): Promise<string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'discord-bot-fleet',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const base = `https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  try {
    if (args.kind === 'info') {
      const r = await fetch(base, { headers });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      const j = (await r.json()) as Record<string, unknown>;
      return JSON.stringify({
        name: j.full_name,
        description: j.description,
        stars: j.stargazers_count,
        forks: j.forks_count,
        open_issues: j.open_issues_count,
        language: j.language,
        license: (j.license as { name?: string } | null)?.name,
        default_branch: j.default_branch,
        created: j.created_at,
        updated: j.updated_at,
        homepage: j.homepage,
        topics: j.topics,
      });
    } else if (args.kind === 'readme') {
      const r = await fetch(`${base}/readme`, { headers: { ...headers, 'Accept': 'application/vnd.github.raw' } });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      const text = await r.text();
      return text.slice(0, 5000);
    } else {
      const r = await fetch(`${base}/commits?per_page=10`, { headers });
      if (!r.ok) return JSON.stringify({ error: `HTTP ${r.status}` });
      const j = (await r.json()) as Array<Record<string, unknown>>;
      return JSON.stringify(j.map((c) => ({
        sha: String(c.sha || '').slice(0, 7),
        message: String(((c.commit as { message?: string }) || {}).message || '').split('\n')[0],
        author: (c.author as { login?: string } | undefined)?.login || ((c.commit as { author?: { login?: string } })?.author?.login) || 'unknown',
        date: ((c.commit as { author?: { date?: string } })?.author)?.date,
      })));
    }
  } catch (e: unknown) {
    const err = e as Error;
    return JSON.stringify({ error: err.message || String(e) });
  }
}
