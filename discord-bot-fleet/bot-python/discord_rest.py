"""Discord REST API client — no WebSocket, just HTTP polling.

This is the workaround for HF Space's blocked WS egress to Discord's gateway.
We poll /channels/:id/messages every ~1.5s and send messages via REST.

Optional: route through a Cloudflare Worker proxy by setting DISCORD_PROXY_URL
env var. The Worker (vertex-proxy-worker pattern) forwards to discord.com using
Cloudflare's clean edge IPs, bypassing Discord's WAF block on HF Space egress.

Rate limits: Discord allows 50 req/s per bot. With 1.5s poll interval across
30 channels, we use ~20 req/s — well within budget.
"""

import asyncio
import os
import time
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse, urlencode

import aiohttp

DISCORD_API = 'https://discord.com/api/v10'
# Optional Cloudflare Worker proxy for HF Space egress
# Format: https://your-worker.workers.dev
# If set, all Discord requests route through: <proxy>/proxy/<encoded-discord-url>
DISCORD_PROXY_URL = os.environ.get('DISCORD_PROXY_URL', '').rstrip('/').strip()


def _wrap_url(discord_path: str) -> str:
    """If DISCORD_PROXY_URL is set, return the Worker URL that proxies the Discord URL.
    Otherwise return the Discord URL directly.
    """
    target = f'{DISCORD_API}{discord_path}'
    if not DISCORD_PROXY_URL:
        return target
    return f'{DISCORD_PROXY_URL}/proxy/{quote(target, safe="")}'


class DiscordRestClient:
    def __init__(self, token: str, bot_id: str, log=None):
        self.token = token
        self.bot_id = bot_id  # fleet-internal ID, not Discord user ID
        self.log = log
        self._session: Optional[aiohttp.ClientSession] = None
        self._global_rate_limit_until = 0.0
        self._route_cooldowns: Dict[str, float] = {}  # route_key -> until_time
        self._user_id: Optional[str] = None
        self._user_name: Optional[str] = None
        self._lock = asyncio.Lock()

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            # Bumped timeouts — when using CF Worker proxy, latency is a bit higher
            timeout = aiohttp.ClientTimeout(total=60, connect=30, sock_read=30)
            headers = {
                'Authorization': f'Bot {self.token}',
                'User-Agent': 'DiscordBot (https://example.com, 1.0)',
            }
            self._session = aiohttp.ClientSession(
                timeout=timeout,
                headers=headers,
            )
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _request(self, method: str, path: str, json_body: Optional[Dict] = None, route_key: Optional[str] = None) -> Dict[str, Any]:
        """Make a rate-limit-aware Discord REST call, optionally via CF Worker."""
        async with self._lock:
            # Wait for global rate limit
            now = time.time()
            if now < self._global_rate_limit_until:
                wait = self._global_rate_limit_until - now
                if self.log:
                    self.log.debug(f'Global rate limit wait {wait:.2f}s')
                await asyncio.sleep(wait)

            # Wait for route-specific rate limit
            if route_key and route_key in self._route_cooldowns:
                now = time.time()
                if now < self._route_cooldowns[route_key]:
                    wait = self._route_cooldowns[route_key] - now
                    if self.log:
                        self.log.debug(f'Route {route_key} cooldown {wait:.2f}s')
                    await asyncio.sleep(wait)

            session = await self._get_session()
            url = _wrap_url(path)
            try:
                async with session.request(method, url, json=json_body) as resp:
                    # Handle rate limits
                    if resp.status == 429:
                        try:
                            body = await resp.json()
                        except Exception:
                            body = {}
                        retry_after = float(body.get('retry_after', 1.0))
                        if self.log:
                            self.log.warn(f'Rate limited on {method} {path}, waiting {retry_after}s')
                        if resp.headers.get('X-RateLimit-Global'):
                            self._global_rate_limit_until = time.time() + retry_after
                        elif route_key:
                            self._route_cooldowns[route_key] = time.time() + retry_after
                        return {'_error': 'rate_limited', '_retry_after': retry_after}

                    # Update route cooldown from headers
                    if route_key and resp.headers.get('X-RateLimit-Remaining') == '0':
                        reset = float(resp.headers.get('X-RateLimit-Reset', '0'))
                        if reset > 0:
                            self._route_cooldowns[route_key] = reset

                    if resp.status >= 400:
                        text = await resp.text()
                        if self.log:
                            self.log.error(f'Discord API {method} {path} -> {resp.status}: {text[:300]}')
                        return {'_error': f'http_{resp.status}', '_body': text[:500]}

                    if resp.status == 204:
                        return {}
                    return await resp.json()
            except asyncio.TimeoutError:
                return {'_error': 'timeout'}
            except Exception as e:
                if self.log:
                    self.log.error(f'Discord API request failed: {method} {path}', error=str(e))
                return {'_error': str(e)}

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
        return [c for c in r if c.get('type') == 0]  # 0 = text channel

    async def get_recent_messages(self, channel_id: str, limit: int = 25, after: Optional[str] = None) -> List[Dict[str, Any]]:
        """Returns up to `limit` most recent messages, optionally after a message ID."""
        path = f'/channels/{channel_id}/messages?limit={limit}'
        if after:
            path += f'&after={after}'
        r = await self._request('GET', path, route_key=f'channel:{channel_id}:read')
        if '_error' in r:
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
        # Emoji must be URL-encoded (e.g. %F0%9F%8C%B8 for 🌸)
        from urllib.parse import quote
        await self._request('PUT', f'/channels/{channel_id}/messages/{message_id}/reactions/{quote(emoji)}/@me',
                             route_key=f'channel:{channel_id}:react')
