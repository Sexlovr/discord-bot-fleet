"""fetch_url — fetches a URL and returns sanitized text. SSRF-protected."""

import json
import socket
import ipaddress
import re
from urllib.parse import urlparse
import aiohttp

FETCH_URL_TOOL = {
    'type': 'function',
    'function': {
        'name': 'fetch_url',
        'description': 'Fetch a URL and return the text content (HTML stripped). Useful for reading articles, documentation, or API responses. Limited to 5000 chars. Cannot access private/internal IP ranges.',
        'parameters': {
            'type': 'object',
            'properties': {
                'url': {'type': 'string', 'description': 'The URL to fetch'},
                'max_chars': {'type': 'number', 'description': 'Max chars to return (default 5000, max 10000)'},
            },
            'required': ['url'],
        },
    },
}


PRIVATE_HOSTS = {
    'localhost', 'metadata.google.internal', 'metadata.azure.com',
    '169.254.169.254',
}


def is_private_host(hostname: str) -> bool:
    host = hostname.strip('[]').lower()
    if host in PRIVATE_HOSTS:
        return True
    if host.endswith('.internal') or host.endswith('.local'):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        pass
    # DNS lookup to catch rebinding attacks
    try:
        results = socket.getaddrinfo(host, None)
        for r in results:
            ip_str = r[4][0]
            try:
                ip_obj = ipaddress.ip_address(ip_str)
                if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved:
                    return True
            except ValueError:
                continue
    except Exception:
        pass
    return False


async def fetch_url_handler(args, ctx):
    url = args.get('url', '').strip()
    if not url:
        return json.dumps({'error': 'url required'})
    max_chars = min(int(args.get('max_chars', 5000)), 10000)
    try:
        parsed = urlparse(url)
    except Exception:
        return json.dumps({'error': f'invalid URL: {url}'})
    if parsed.scheme not in ('http', 'https'):
        return json.dumps({'error': f'only http/https allowed, got: {parsed.scheme}'})
    if not parsed.hostname:
        return json.dumps({'error': 'no hostname in URL'})
    if is_private_host(parsed.hostname):
        return json.dumps({'error': f'blocked: {parsed.hostname} is a private/internal address'})

    try:
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10),
            headers={'User-Agent': 'Mozilla/5.0 (compatible; DiscordBot/1.0)'},
        ) as session:
            async with session.get(url, allow_redirects=True) as resp:
                if resp.status != 200:
                    return json.dumps({'error': f'HTTP {resp.status} {resp.reason}', 'url': url})
                ct = resp.headers.get('content-type', '')
                body = await resp.text()
        if 'application/json' in ct:
            text = body
        elif 'text/html' in ct:
            text = re.sub(r'<script[\s\S]*?</script>', '', body, flags=re.IGNORECASE)
            text = re.sub(r'<style[\s\S]*?</style>', '', text, flags=re.IGNORECASE)
            text = re.sub(r'<[^>]+>', ' ', text)
            text = (text.replace('&nbsp;', ' ').replace('&amp;', '&')
                        .replace('&lt;', '<').replace('&gt;', '>')
                        .replace('&quot;', '"').replace('&#39;', "'"))
            text = re.sub(r'\s+', ' ', text).strip()
        else:
            text = body
        return text[:max_chars]
    except Exception as e:
        return json.dumps({'error': str(e), 'url': url})
