"""Discord REST API client — no WebSocket, just HTTP polling.

Uses curl_cffi with Chrome TLS impersonation. Plain aiohttp gets blocked by
Cloudflare when calling *.workers.dev from HF Space — but curl_cffi mimics
Chrome's TLS fingerprint and slips past.

Tested working: chinese-gemini (HF Space) uses curl_cffi to reach the same
vertex-proxy-worker pattern successfully.

Rate limits: Discord allows 50 req/s per bot. With 1.5s poll interval across
30 channels, we use ~20 req/s — well within budget.
"""

import asyncio
import os
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from curl_cffi import requests as cf_requests

DISCORD_API = 'https://discord.com/api/v10'
# Optional Cloudflare Worker proxy for HF Space egress — comma-separated list
# for failover. Format:
#   https://worker1.workers.dev,https://worker2.workers.dev
DISCORD_PROXY_URLS = [
    u.strip().rstrip('/') for u in os.environ.get('DISCORD_PROXY_URL', '').split(',')
    if u.strip()
]

# Round-robin state (per-process)
_proxy_index = 0


def _wrap_url(discord_path: str) -> str:
    """If DISCORD_PROXY_URL is set, return the Worker URL that proxies the Discord URL."""
    global _proxy_index
    target = f'{DISCORD_API}{discord_path}'
    if not DISCORD_PROXY_URLS:
        return target
    proxy = DISCORD_PROXY_URLS[_proxy_index % len(DISCORD_PROXY_URLS)]
    _proxy_index += 1
    return f'{proxy}/proxy/{quote(target, safe="")}'


class DiscordRestClient:
    def __init__(self, token: str, bot_id: str, log=None):
        self.token = token
        self.bot_id = bot_id  # fleet-internal ID, not Discord user ID
        self.log = log
        self._session: Optional[cf_requests.AsyncSession] = None
        self._global_rate_limit_until = 0.0
        self._route_cooldowns: Dict[str, float] = {}  # route_key -> until_time
        self._user_id: Optional[str] = None
        self._user_name: Optional[str] = None
        self._lock = asyncio.Lock()

    async def _get_session(self) -> cf_requests.AsyncSession:
        if self._session is None:
            # curl_cffi AsyncSession with Chrome impersonation to bypass CF WAF
            self._session = cf_requests.AsyncSession(
                impersonate='chrome',
                timeout=30,
                headers={
                    'Authorization': f'Bot {self.token}',
                    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                },
            )
        return self._session

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._session = None

    async def _request(self, method: str, path: str, json_body: Optional[Dict] = None, route_key: Optional[str] = None) -> Dict[str, Any]:
        """Make a rate-limit-aware Discord REST call via curl_cffi."""
        async with self._lock:
            # Wait for global rate limit
            now = time.time()
            if now < self._global_rate_limit_until:
                await asyncio.sleep(self._global_rate_limit_until - now)

            # Wait for route-specific rate limit
            if route_key and route_key in self._route_cooldowns:
                now = time.time()
                if now < self._route_cooldowns[route_key]:
                    await asyncio.sleep(self._route_cooldowns[route_key] - now)

            session = await self._get_session()
            url = _wrap_url(path)
            if self.log:
                self.log.debug(f'{method} {path} -> {url}')
            try:
                resp = await session.request(method, url, json=json_body)
                status = resp.status_code
                headers = resp.headers

                # Handle rate limits
                if status == 429:
                    try:
                        body = resp.json()
                    except Exception:
                        body = {}
                    retry_after = float(body.get('retry_after', 1.0))
                    if self.log:
                        self.log.warn(f'Rate limited on {method} {path}, waiting {retry_after}s')
                    if headers.get('X-RateLimit-Global'):
                        self._global_rate_limit_until = time.time() + retry_after
                    elif route_key:
                        self._route_cooldowns[route_key] = time.time() + retry_after
                    return {'_error': 'rate_limited', '_retry_after': retry_after}

                # Update route cooldown from headers
                if route_key and headers.get('X-RateLimit-Remaining') == '0':
                    reset = float(headers.get('X-RateLimit-Reset', '0'))
                    if reset > 0:
                        self._route_cooldowns[route_key] = reset

                if status >= 400:
                    text = resp.text
                    if self.log:
                        self.log.error(f'Discord API {method} {path} -> {status}: {text[:300]}')
                    return {'_error': f'http_{status}', '_body': text[:500]}

                if status == 204:
                    return {}
                try:
                    return resp.json()
                except Exception:
                    return {'_raw_text': resp.text[:500]}
            except asyncio.TimeoutError:
                return {'_error': 'timeout'}
            except Exception as e:
                import traceback
                if self.log:
                    self.log.error(
                        f'Discord API request failed: {method} {path} -> {url}',
                        error=f'{type(e).__name__}: {str(e)[:200]}',
                        traceback=traceback.format_exc()[-400:],
                    )
                return {'_error': str(e), '_type': type(e).__name__}

    async def validate_token(self) -> Dict[str, Any]:
        """Returns bot user info if token is valid."""
        r = await self._request('GET', '/users/@me')
        if '_error' in r:
            return r
        self._user_id = r.get('id')
        self._user_name = r.get('username')
        return r

    @property
    def user_id(self) -> Optional[str]:
        return self._user_id

    @property
    def user_name(self) -> Optional[str]:
        return self._user_name

    async def get_guild_channels(self, guild_id: str) -> List[Dict[str, Any]]:
        r = await self._request('GET', f'/guilds/{guild_id}/channels', route_key=f'guild:{guild_id}')
        if '_error' in r:
            return []
        return [c for c in r if c.get('type') == 0]

    async def get_recent_messages(self, channel_id: str, limit: int = 25, after: Optional[str] = None) -> List[Dict[str, Any]]:
        """Returns up to `limit` most recent messages, optionally after a message ID."""
        path = f'/channels/{channel_id}/messages?limit={limit}'
        if after:
            path += f'&after={after}'
        r = await self._request('GET', path, route_key=f'channel:{channel_id}:read')
        if '_error' in r or not isinstance(r, list):
            return []
        # Discord returns most recent first; reverse for chronological
        return list(reversed(r))

    async def send_message(self, channel_id: str, content: str) -> Dict[str, Any]:
        return await self._request('POST', f'/channels/{channel_id}/messages',
                                    json_body={'content': content[:2000]},
                                    route_key=f'channel:{channel_id}:write')

    async def trigger_typing(self, channel_id: str) -> None:
        await self._request('POST', f'/channels/{channel_id}/typing',
                             route_key=f'channel:{channel_id}:write')

    async def add_reaction(self, channel_id: str, message_id: str, emoji: str) -> None:
        from urllib.parse import quote as _quote
        await self._request('PUT', f'/channels/{channel_id}/messages/{message_id}/reactions/{_quote(emoji)}/@me',
                             route_key=f'channel:{channel_id}:react')
