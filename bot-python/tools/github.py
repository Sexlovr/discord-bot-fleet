"""github_lookup — read-only GitHub repo metadata via public API."""

import json
import os
import aiohttp

GITHUB_TOOL = {
    'type': 'function',
    'function': {
        'name': 'github_lookup',
        "description": "Look up a GitHub repo's metadata, README, or recent commits. Read-only, no authentication required (uses public API rate limits).",
        'parameters': {
            'type': 'object',
            'properties': {
                'owner': {'type': 'string', 'description': 'Repo owner (e.g. "facebook")'},
                'repo': {'type': 'string', 'description': 'Repo name (e.g. "react")'},
                'kind': {'type': 'string', 'enum': ['info', 'readme', 'commits'], 'description': 'What to fetch: repo info, README content, or recent commits'},
            },
            'required': ['owner', 'repo', 'kind'],
        },
    },
}


async def github_handler(args, ctx):
    owner = args.get('owner', '').strip()
    repo = args.get('repo', '').strip()
    kind = args.get('kind', 'info')
    if not owner or not repo:
        return json.dumps({'error': 'owner and repo required'})
    headers = {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'discord-bot-fleet',
    }
    if os.environ.get('GITHUB_TOKEN'):
        headers['Authorization'] = f'Bearer {os.environ["GITHUB_TOKEN"]}'
    base = f'https://api.github.com/repos/{owner}/{repo}'
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            if kind == 'info':
                async with session.get(base, headers=headers) as r:
                    if r.status != 200:
                        return json.dumps({'error': f'HTTP {r.status}'})
                    j = await r.json()
                    return json.dumps({
                        'name': j.get('full_name'),
                        'description': j.get('description'),
                        'stars': j.get('stargazers_count'),
                        'forks': j.get('forks_count'),
                        'open_issues': j.get('open_issues_count'),
                        'language': j.get('language'),
                        'license': (j.get('license') or {}).get('name'),
                        'default_branch': j.get('default_branch'),
                        'created': j.get('created_at'),
                        'updated': j.get('updated_at'),
                        'homepage': j.get('homepage'),
                        'topics': j.get('topics'),
                    })
            elif kind == 'readme':
                h2 = {**headers, 'Accept': 'application/vnd.github.raw'}
                async with session.get(f'{base}/readme', headers=h2) as r:
                    if r.status != 200:
                        return json.dumps({'error': f'HTTP {r.status}'})
                    text = await r.text()
                    return text[:5000]
            else:
                async with session.get(f'{base}/commits?per_page=10', headers=headers) as r:
                    if r.status != 200:
                        return json.dumps({'error': f'HTTP {r.status}'})
                    j = await r.json()
                    return json.dumps([
                        {
                            'sha': str(c.get('sha', ''))[:7],
                            'message': ((c.get('commit') or {}).get('message') or '').split('\n')[0],
                            'author': ((c.get('author') or {}).get('login')) or
                                     (((c.get('commit') or {}).get('author') or {}).get('login')) or 'unknown',
                            'date': ((c.get('commit') or {}).get('author') or {}).get('date'),
                        }
                        for c in j
                    ])
    except Exception as e:
        return json.dumps({'error': str(e)})
