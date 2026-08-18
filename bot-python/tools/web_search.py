"""web_search — DuckDuckGo HTML scrape, no API key required."""

import json
import re
from urllib.parse import quote
import aiohttp

WEB_SEARCH_TOOL = {
    'type': 'function',
    'function': {
        'name': 'web_search',
        'description': 'Search the web for current information. Returns up to 5 results with title, URL, and a short snippet. Use this when you need up-to-date info beyond your training data.',
        'parameters': {
            'type': 'object',
            'properties': {
                'query': {'type': 'string', 'description': 'Search query'},
            },
            'required': ['query'],
        },
    },
}


async def web_search_handler(args, ctx):
    query = args.get('query', '').strip()
    if not query:
        return json.dumps({'error': 'query required'})
    url = f'https://html.duckduckgo.com/html/?q={quote(query)}'
    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10),
            headers={'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)'},
        ) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return json.dumps({'error': f'HTTP {resp.status}'})
                html = await resp.text()
        # Parse result blocks
        link_re = re.compile(r'<a class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>', re.IGNORECASE)
        snippet_re = re.compile(r'<a class="result__snippet"[^>]*>([\s\S]*?)</a>', re.IGNORECASE)
        links = []
        for m in link_re.finditer(html):
            if len(links) >= 5:
                break
            raw = m.group(1)
            u = re.search(r'uddg=([^&]+)', raw)
            actual_url = __import__('urllib.parse').unquote(u.group(1)) if u else raw
            title = re.sub(r'<[^>]+>', '', m.group(2)).strip()
            links.append({'url': actual_url, 'title': title})
        snippets = []
        for m in snippet_re.finditer(html):
            if len(snippets) >= 5:
                break
            snippets.append(re.sub(r'<[^>]+>', '', m.group(1)).strip())
        results = []
        for i, link in enumerate(links):
            results.append({**link, 'snippet': snippets[i] if i < len(snippets) else ''})
        if not results:
            return json.dumps({'error': 'no results found', 'query': query})
        return json.dumps({'query': query, 'results': results})
    except Exception as e:
        return json.dumps({'error': str(e)})
