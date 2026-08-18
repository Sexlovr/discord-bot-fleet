"""Universal bot runtime — REST polling edition (no WebSocket).

Why REST polling instead of discord.py WebSocket gateway?
Discord's Cloudflare WAF silently drops SYN packets from HF Space's shared
datacenter egress IPs to gateway.discord.gg (162.159.x.x range). The WSS
connection times out after 75s. REST API works fine.

We poll /channels/:id/messages every ~1.5s for new messages. Latency: 1-3s.
Discord rate limit budget: 50 req/s per bot. At 1.5s interval across 30
channels, we use ~20 req/s — comfortable.
"""

import asyncio
import json
import os
import random
import re
import sys
import signal
import time
from typing import Dict, List, Optional

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from crypto import decrypt_string
from store import get_bot, update_bot
from logger import get_logger
from llm import LLMClient
from discord_rest import DiscordRestClient
from tools import get_enabled_tools, dispatch_tool, ToolContext


def get_bot_id_from_args() -> Optional[str]:
    for arg in sys.argv[1:]:
        if arg.startswith('--id='):
            return arg[len('--id='):]
    return None


# In-process state
channel_history: Dict[str, List[Dict]] = {}      # channel_id -> list of LLM messages
last_seen_message_id: Dict[str, str] = {}         # channel_id -> last processed message ID
last_reply_at: Dict[str, float] = {}              # channel_id -> unix timestamp
pending_summons: Dict[str, Dict] = {}             # summon_key -> {future, timer_task}


def chunk_string(s: str, size: int = 2000) -> List[str]:
    if len(s) <= size:
        return [s]
    chunks = []
    i = 0
    while i < len(s):
        end = i + size
        if end < len(s):
            last_nl = s.rfind('\n', i, end)
            if last_nl > i + 200:
                end = last_nl
        chunks.append(s[i:end])
        i = end
    return chunks


def is_private_host(hostname: str) -> bool:
    """Quick SSRF check for fetch_url — same as fetch_url.py."""
    import ipaddress
    import socket
    host = hostname.strip('[]').lower()
    if host in ('localhost', 'metadata.google.internal', 'metadata.azure.com', '169.254.169.254'):
        return True
    if host.endswith('.internal') or host.endswith('.local'):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
    except ValueError:
        pass
    try:
        for r in socket.getaddrinfo(host, None):
            ip_obj = ipaddress.ip_address(r[4][0])
            if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved:
                return True
    except Exception:
        pass
    return False


async def main():
    bot_id = get_bot_id_from_args()
    if not bot_id:
        print('Usage: python3 bot.py --id=<bot_id>', flush=True)
        sys.exit(1)

    config = get_bot(bot_id)
    if not config:
        print(f'Bot config not found: {bot_id}', flush=True)
        sys.exit(2)

    log = get_logger(bot_id)
    log.info('Bot process starting (REST polling mode)', bot_id=bot_id, name=config.get('name', ''))

    if not config.get('token_enc'):
        log.error('No token configured for this bot. Set it via the web panel.')
        sys.exit(3)

    try:
        token = decrypt_string(config['token_enc'])
    except Exception as e:
        log.error('Failed to decrypt token', error=str(e))
        sys.exit(3)

    # Validate token + fetch bot user ID (with retry — HF Space egress to discord.com can be slow on first request)
    rest = DiscordRestClient(token, bot_id, log)
    if os.environ.get('DISCORD_PROXY_URL'):
        proxy_count = len([u for u in os.environ['DISCORD_PROXY_URL'].split(',') if u.strip()])
        log.info(f'Routing Discord traffic through {proxy_count} worker(s): {os.environ["DISCORD_PROXY_URL"]}')
    else:
        log.info('Direct Discord connection (no proxy — may fail on HF Space)')
    log.info('Validating Discord token...')
    user_info = None
    for attempt in range(1, 4):
        user_info = await rest.validate_token()
        if '_error' not in user_info:
            break
        log.warn(f'Token validation attempt {attempt}/3 failed', error=user_info.get('_error'))
        if attempt < 3:
            await asyncio.sleep(2 * attempt)
    if user_info is None or '_error' in user_info:
        log.error('Token validation failed after 3 attempts', error=user_info.get('_error') if user_info else 'no response')
        await rest.close()
        sys.exit(4)

    discord_user_id = user_info.get('id')
    discord_username = user_info.get('username', '?')
    log.info(f'Token valid — bot is {discord_username} (id={discord_user_id})')

    # Cache discord_user_id in config so other bots can summon this one
    if str(discord_user_id) != config.get('discord_user_id'):
        try:
            update_bot(bot_id, {'discord_user_id': str(discord_user_id)})
            config['discord_user_id'] = str(discord_user_id)
            log.info('Cached Discord user ID', user_id=str(discord_user_id))
        except Exception as e:
            log.error('Failed to cache discord_user_id', error=str(e))

    # Set status to "online" via REST (so the bot shows as online in Discord)
    # Note: This sets presence via REST which is supported but rate-limited.
    # For now skip — bot will show as "online" when it sends its first message.
    # Actually, presence via REST is not supported (Discord only allows presence via WS Gateway).
    # So the bot will appear "offline" in the member list, but messages will still arrive.
    # This is acceptable for a chat bot — users will see her replies and know she's "there".

    llm = LLMClient(config)

    # ─── Helpers ─────────────────────────────────────────────────────────
    def get_history(channel_id: str) -> List[Dict]:
        if channel_id not in channel_history:
            channel_history[channel_id] = []
        return channel_history[channel_id]

    def push_history(channel_id: str, msg: Dict) -> None:
        h = get_history(channel_id)
        h.append(msg)
        max_ctx = config.get('gating', {}).get('max_context_messages', 30)
        while len(h) > max_ctx:
            h.pop(0)

    def should_respond(author_bot: bool, author_id: str, content: str, channel_id: str) -> bool:
        gating = config.get('gating', {})
        # Never respond to self
        if author_id == discord_user_id:
            return False
        if gating.get('ignore_bots', True) and author_bot:
            # Exception: if this is a delegated bot's reply and we're waiting for it,
            # the summon_bot handler will pick it up — don't double-respond.
            return False
        if gating.get('ignore_own_messages', True) and author_id == discord_user_id:
            return False
        for pat in gating.get('skip_patterns', []):
            try:
                if re.search(pat, content.strip(), re.IGNORECASE):
                    return False
            except re.error:
                continue
        cooldown_ms = gating.get('cooldown_ms', 2000)
        last = last_reply_at.get(channel_id, 0)
        if (time.time() - last) * 1000 < cooldown_ms:
            return False
        prob = gating.get('response_probability', 0.7)
        if random.random() > prob:
            return False
        return True

    # ─── Tool context ────────────────────────────────────────────────────
    async def send_channel_message(channel_id: str, content: str) -> None:
        try:
            await rest.send_message(channel_id, content)
        except Exception as e:
            log.error('send_channel_message failed', channel_id=channel_id, error=str(e))

    async def add_reaction(channel_id: str, message_id: str, emoji: str) -> None:
        try:
            await rest.add_reaction(channel_id, message_id, emoji)
        except Exception as e:
            log.warn('Failed to add reaction', emoji=emoji, error=str(e))

    async def summon_bot_impl(target_bot_id: str, message: str, timeout_sec: int, channel_id: str) -> str:
        target = get_bot(target_bot_id)
        if not target:
            return json.dumps({'error': f'unknown bot: {target_bot_id}'})
        if not target.get('discord_user_id'):
            return json.dumps({
                'error': f'target bot "{target.get("name", "?")}" has no Discord user ID cached',
                'hint': 'start the target bot at least once so we learn its user ID',
            })

        target_uid = target['discord_user_id']
        target_name = target.get('name', '?')

        summon_key = f'{target_bot_id}:{channel_id}'
        if summon_key in pending_summons:
            return json.dumps({
                'error': 'summon already in flight',
                'hint': f'another summon to bot "{target_name}" in this channel is already waiting.',
            })

        mention = f'<@{target_uid}> {message}'
        log.info('Summoning bot', target=target_name, target_id=target_bot_id, message_preview=message[:80])
        await rest.send_message(channel_id, mention)

        loop = asyncio.get_event_loop()
        future = loop.create_future()
        timer = loop.call_later(timeout_sec, lambda: (
            future.set_result(json.dumps({
                'ok': False,
                'error': 'timeout',
                'timeout_sec': timeout_sec,
                'hint': f'bot "{target_name}" did not reply within {timeout_sec}s.',
            })) if not future.done() else None
        ))
        pending_summons[summon_key] = {'future': future, 'timer': timer, 'target_uid': target_uid}
        try:
            return await future
        finally:
            pending_summons.pop(summon_key, None)
            timer.cancel()

    ctx = ToolContext(
        bot_config=config,
        send_channel_message=send_channel_message,
        add_reaction=add_reaction,
        summon_bot=summon_bot_impl,
        discord_client=rest,
    )

    # ─── Handle one new message ──────────────────────────────────────────
    async def handle_message(message: Dict, channel_id: str):
        author = message.get('author', {})
        author_id = author.get('id', '')
        author_name = author.get('username', '?')
        author_bot = author.get('bot', False)
        content = message.get('content', '') or ''
        message_id = message.get('id', '')

        # If this is from a delegated bot, check pending summons
        delegated = config.get('delegated_bots') or []
        if author_bot and delegated:
            for target_id in delegated:
                target = get_bot(target_id)
                if target and target.get('discord_user_id') == author_id:
                    summon_key = f'{target_id}:{channel_id}'
                    pending = pending_summons.get(summon_key)
                    if pending and not pending['future'].done():
                        pending['timer'].cancel()
                        pending['future'].set_result(json.dumps({
                            'ok': True,
                            'target_bot': target.get('name', '?'),
                            'response': content,
                        }))
                    return  # don't double-respond

        # Skip own messages
        if author_id == discord_user_id:
            return

        # Push to history regardless
        push_history(channel_id, {
            'role': 'user',
            'content': f'{author_name}: {content}',
        })

        if not should_respond(author_bot, author_id, content, channel_id):
            return

        log.info('Responding to message', author=author_name, channel=channel_id, content_preview=content[:80])

        # Trigger typing indicator
        await rest.trigger_typing(channel_id)

        # Build LLM messages: system + history
        llm_messages = [
            {'role': 'system', 'content': config.get('persona', '')},
            *get_history(channel_id),
        ]

        enabled_tools = get_enabled_tools(config)
        MAX_TOOL_ROUNDS = 5
        rounds = 0

        while rounds < MAX_TOOL_ROUNDS:
            try:
                resp = await llm.chat(llm_messages, enabled_tools)
            except Exception as e:
                log.error('LLM call failed', error=str(e))
                return
            rounds += 1

            if resp.get('tool_calls'):
                llm_messages.append({
                    'role': 'assistant',
                    'content': resp.get('content') or '',
                    'tool_calls': resp['tool_calls'],
                })
                push_history(channel_id, {
                    'role': 'assistant',
                    'content': resp.get('content') or '(calling tools...)',
                })

                for tc in resp['tool_calls']:
                    fn = tc.get('function', {})
                    tool_name = fn.get('name', '')
                    args_str = fn.get('arguments', '{}')
                    log.info('Tool call', name=tool_name, args=args_str[:200])
                    try:
                        parsed_args = json.loads(args_str) if args_str else {}
                    except json.JSONDecodeError:
                        log.warn('Tool call args parse failed', raw=args_str[:200])
                        parsed_args = {}
                    parsed_args['_channel_id'] = channel_id
                    result = await dispatch_tool(tool_name, parsed_args, ctx)
                    log.info('Tool result', name=tool_name, result_preview=result[:200])
                    llm_messages.append({
                        'role': 'tool',
                        'content': result,
                        'tool_call_id': tc.get('id', ''),
                        'name': tool_name,
                    })
                continue

            # Final response
            reply = (resp.get('content') or '').strip()
            if not reply:
                log.warn('LLM returned empty content, skipping reply')
                return

            chunks = chunk_string(reply, 2000)
            try:
                for chunk in chunks:
                    await rest.send_message(channel_id, chunk)
            except Exception as e:
                log.error('Failed to send reply to Discord', error=str(e), channel=channel_id)
                return

            push_history(channel_id, {'role': 'assistant', 'content': reply})
            last_reply_at[channel_id] = time.time()

            # Random emoji reaction (10%)
            if config.get('tools', {}).get('react_to_message') and random.random() < 0.1:
                emojis = ['🌸', '✨', '💫', '💜', '🌙', '🍯']
                try:
                    await rest.add_reaction(channel_id, message_id, random.choice(emojis))
                except Exception:
                    pass

            log.info('Sent reply', preview=reply[:80], tokens=resp.get('usage', {}).get('total_tokens') if resp.get('usage') else None)
            return

        log.warn('Hit MAX_TOOL_ROUNDS, giving up without final reply')

    # ─── Polling loop ────────────────────────────────────────────────────
    POLL_INTERVAL_SEC = 1.5
    channel_ids = config.get('channel_ids') or []

    log.info(f'Polling {len(channel_ids)} channels every {POLL_INTERVAL_SEC}s')

    # Bootstrap: get the most recent message ID per channel so we only process NEW messages
    log.info('Bootstrapping channel state...')
    for cid in channel_ids:
        try:
            messages = await rest.get_recent_messages(cid, limit=1)
            if messages:
                last_seen_message_id[cid] = messages[-1].get('id', '')
                log.debug(f'Channel {cid}: last seen message {last_seen_message_id[cid]}')
            else:
                last_seen_message_id[cid] = '0'
        except Exception as e:
            log.warn(f'Failed to bootstrap channel {cid}', error=str(e))
            last_seen_message_id[cid] = '0'
    log.info('Bootstrap complete')

    # Optional: send "online" message — comment out if you don't want this
    # await rest.send_message(channel_ids[0], "ara ara~ Yuki's here, dears 🌸")

    # Main polling loop
    try:
        while True:
            for cid in channel_ids:
                try:
                    after_id = last_seen_message_id.get(cid, '0')
                    messages = await rest.get_recent_messages(cid, limit=25, after=after_id)
                    if not messages:
                        continue
                    # Update last seen
                    last_seen_message_id[cid] = messages[-1].get('id', after_id)
                    # Handle each new message
                    for msg in messages:
                        try:
                            await handle_message(msg, cid)
                        except Exception as e:
                            log.error('Error handling message', error=str(e), message_id=msg.get('id', '?'))
                except Exception as e:
                    log.error(f'Polling channel {cid} failed', error=str(e))
            await asyncio.sleep(POLL_INTERVAL_SEC)
    except asyncio.CancelledError:
        log.info('Polling cancelled, shutting down')
    except Exception as e:
        log.error('Polling loop crashed', error=str(e))
    finally:
        await rest.close()


def sigterm_handler(signum, frame):
    print(f'[bot] Received signal {signum}, exiting', flush=True)
    sys.exit(0)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)
    asyncio.run(main())
