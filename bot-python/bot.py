"""Universal bot runtime — Python edition.
Run as: python3 bot.py --id=<bot_id>

Uses discord.py + websockets (different TLS fingerprint than Node's ws lib,
which appears to slip past Discord's Cloudflare WAF that blocks HF egress).
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

import discord

# Make sibling modules importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from crypto import decrypt_string
from store import get_bot, update_bot
from logger import get_logger
from llm import LLMClient
from tools import get_enabled_tools, dispatch_tool, ToolContext


def get_bot_id_from_args() -> Optional[str]:
    for arg in sys.argv[1:]:
        if arg.startswith('--id='):
            return arg[len('--id='):]
    return None


# ─── In-process state ──────────────────────────────────────────────────────
channel_history: Dict[str, List[Dict]] = {}  # channel_id -> list of LLM messages
last_reply_at: Dict[str, float] = {}         # channel_id -> unix timestamp
pending_summons: Dict[str, Dict] = {}        # summon_key -> {resolve, timeout_task}
message_content_intent_warned_at = 0.0


def main():
    bot_id = get_bot_id_from_args()
    if not bot_id:
        print('Usage: python3 bot.py --id=<bot_id>')
        sys.exit(1)

    config = get_bot(bot_id)
    if not config:
        print(f'Bot config not found: {bot_id}')
        sys.exit(2)

    log = get_logger(bot_id)
    log.info('Bot process starting', bot_id=bot_id, name=config.get('name', ''))

    if not config.get('token_enc'):
        log.error('No token configured for this bot. Set it via the web panel.')
        sys.exit(3)

    try:
        token = decrypt_string(config['token_enc'])
    except Exception as e:
        log.error('Failed to decrypt token', error=str(e))
        sys.exit(3)

    # Intents — message_content + members are privileged, must be enabled in Dev Portal
    intents = discord.Intents.default()
    intents.message_content = True
    intents.members = True

    client = discord.Client(intents=intents)
    llm = LLMClient(config)

    # ─── Helper functions ────────────────────────────────────────────────
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

    def should_respond(author_bot: bool, content: str, channel_id: str) -> bool:
        gating = config.get('gating', {})
        if gating.get('ignore_own_messages', True) and author_bot:
            return False
        if gating.get('ignore_bots', True) and author_bot:
            return False
        for pat in gating.get('skip_patterns', []):
            try:
                if re.search(pat, content.strip(), re.IGNORECASE):
                    return False
            except re.error:
                continue
        cooldown_ms = gating.get('cooldown_ms', 2000)
        last = last_reply_at.get(channel_id, 0)
        if (time.time() * 1000 - last * 1000) < cooldown_ms:
            return False
        prob = gating.get('response_probability', 0.7)
        if random.random() > prob:
            return False
        return True

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

    # ─── Tool context ────────────────────────────────────────────────────
    async def send_channel_message(channel_id: str, content: str) -> None:
        try:
            ch = client.get_channel(int(channel_id))
            if ch is None:
                ch = await client.fetch_channel(int(channel_id))
            if ch and hasattr(ch, 'send'):
                await ch.send(content)
            else:
                log.warn('send_channel_message: channel not text-based', channel_id=channel_id)
        except Exception as e:
            log.error('send_channel_message failed', channel_id=channel_id, error=str(e))

    async def add_reaction(channel_id: str, message_id: str, emoji: str) -> None:
        try:
            ch = client.get_channel(int(channel_id))
            if ch is None:
                ch = await client.fetch_channel(int(channel_id))
            if ch and hasattr(ch, 'fetch_message'):
                msg = await ch.fetch_message(int(message_id))
                await msg.add_reaction(emoji)
        except Exception as e:
            log.warn('Failed to add reaction', emoji=emoji, error=str(e))

    async def summon_bot_impl(target_bot_id: str, message: str, timeout_sec: int, channel_id: str) -> str:
        from store import get_bot as _get_bot
        target = _get_bot(target_bot_id)
        if not target:
            return json.dumps({'error': f'unknown bot: {target_bot_id}'})
        if not target.get('discord_user_id'):
            return json.dumps({
                'error': f'target bot "{target.get("name", "?")}" has no Discord user ID cached',
                'hint': 'start the target bot at least once so we learn its user ID',
            })

        target_uid = target['discord_user_id']
        target_name = target.get('name', '?')

        # Per (target+channel) in-flight check — prevent race condition
        summon_key = f'{target_bot_id}:{channel_id}'
        if summon_key in pending_summons:
            return json.dumps({
                'error': 'summon already in flight',
                'hint': f'another summon to bot "{target_name}" in this channel is already waiting. Wait for it to complete or time out before summoning again.',
            })

        ch = client.get_channel(int(channel_id))
        if ch is None:
            ch = await client.fetch_channel(int(channel_id))
        if not ch or not hasattr(ch, 'send'):
            return json.dumps({'error': f'channel {channel_id} not found or not text-based'})

        mention = f'<@{target_uid}> {message}'
        log.info('Summoning bot', target=target_name, target_id=target_bot_id, message_preview=message[:80])
        await ch.send(mention)

        # Wait for reply
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        timer = loop.call_later(timeout_sec, lambda: (
            future.set_result(json.dumps({
                'ok': False,
                'error': 'timeout',
                'timeout_sec': timeout_sec,
                'hint': f'bot "{target_name}" did not reply within {timeout_sec}s. Is it running? Does it respond to @mentions?',
            })) if not future.done() else None
        ))
        pending_summons[summon_key] = {'future': future, 'timer': timer}
        try:
            result = await future
            return result
        finally:
            pending_summons.pop(summon_key, None)
            timer.cancel()

    ctx = ToolContext(
        bot_config=config,
        send_channel_message=send_channel_message,
        add_reaction=add_reaction,
        summon_bot=summon_bot_impl,
        discord_client=client,
    )

    # ─── Discord event handlers ─────────────────────────────────────────
    @client.event
    async def on_ready():
        log.info(f'Discord client ready — logged in as {client.user}', username=client.user.name if client.user else '?')
        # Cache our own Discord user ID so other bots in the fleet can summon us
        if client.user and client.user.id and str(client.user.id) != config.get('discord_user_id'):
            try:
                update_bot(bot_id, {'discord_user_id': str(client.user.id)})
                config['discord_user_id'] = str(client.user.id)
                log.info('Cached Discord user ID', user_id=str(client.user.id))
            except Exception as e:
                log.error('Failed to cache discord_user_id', error=str(e))

    @client.event
    async def on_message(message: discord.Message):
        global message_content_intent_warned_at
        try:
            # Ignore messages outside configured guild
            guild_id = config.get('guild_id')
            if guild_id and str(message.guild.id if message.guild else '') != str(guild_id):
                return

            # Ignore messages outside configured channels (if any)
            channel_ids = config.get('channel_ids') or []
            if channel_ids and str(message.channel.id) not in [str(c) for c in channel_ids]:
                return

            # Ignore own messages
            if client.user and message.author.id == client.user.id:
                return

            # Skip messages from delegated bots — handled by summon_bot
            delegated = config.get('delegated_bots') or []
            if message.author.bot and delegated:
                for target_id in delegated:
                    from store import get_bot as _get_bot
                    target = _get_bot(target_id)
                    if target and target.get('discord_user_id') == str(message.author.id):
                        # If there's a pending summon for this (target, channel), fulfill it
                        summon_key = f'{target_id}:{message.channel.id}'
                        pending = pending_summons.get(summon_key)
                        if pending and not pending['future'].done():
                            pending['timer'].cancel()
                            pending['future'].set_result(json.dumps({
                                'ok': True,
                                'target_bot': target.get('name', '?'),
                                'response': message.content,
                            }))
                        return  # don't double-respond

            content = message.content or ''
            is_bot = message.author.bot

            # Detect missing MessageContent intent
            if not content and not message.embeds and not message.attachments:
                now = time.time()
                if now - message_content_intent_warned_at > 300:
                    message_content_intent_warned_at = now
                    log.error('MESSAGE CONTENT INTENT likely missing — received message with empty content. Enable it at https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents → MESSAGE CONTENT INTENT → Save Changes → Restart this bot.')
                return

            # Push to history regardless
            push_history(str(message.channel.id), {
                'role': 'user',
                'content': f'{message.author.name}: {content}',
            })

            if not should_respond(is_bot, content, str(message.channel.id)):
                return

            log.info('Responding to message', author=message.author.name, channel=str(message.channel.id), content_preview=content[:80])

            # Build LLM messages: system + history
            llm_messages = [
                {'role': 'system', 'content': config.get('persona', '')},
                *get_history(str(message.channel.id)),
            ]

            # Tool calling loop
            enabled_tools = get_enabled_tools(config)
            MAX_TOOL_ROUNDS = 5
            rounds = 0

            while rounds < MAX_TOOL_ROUNDS:
                resp = await llm.chat(llm_messages, enabled_tools)
                rounds += 1

                if resp.get('tool_calls'):
                    llm_messages.append({
                        'role': 'assistant',
                        'content': resp.get('content') or '',
                        'tool_calls': resp['tool_calls'],
                    })
                    push_history(str(message.channel.id), {
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
                        # Inject current channel context
                        parsed_args['_channel_id'] = str(message.channel.id)
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
                        await message.channel.send(chunk)
                except Exception as e:
                    log.error('Failed to send reply to Discord', error=str(e), channel=str(message.channel.id))
                    return

                push_history(str(message.channel.id), {'role': 'assistant', 'content': reply})
                last_reply_at[str(message.channel.id)] = time.time()

                # Random emoji reaction (10%)
                if config.get('tools', {}).get('react_to_message') and random.random() < 0.1:
                    emojis = ['🌸', '✨', '💫', '💜', '🌙', '🍯']
                    try:
                        await message.add_reaction(random.choice(emojis))
                    except Exception:
                        pass

                log.info('Sent reply', preview=reply[:80], tokens=resp.get('usage', {}).get('total_tokens') if resp.get('usage') else None)
                return

            log.warn('Hit MAX_TOOL_ROUNDS, giving up without final reply')
        except Exception as e:
            import traceback
            log.error('Error in message handler', error=str(e), stack=traceback.format_exc()[-500:])

    @client.event
    async def on_error(event_name, *args, **kwargs):
        log.error(f'Discord client error in event: {event_name}')

    # ─── Login with retry ────────────────────────────────────────────────
    MAX_LOGIN_ATTEMPTS = 5
    login_ok = False
    for attempt in range(1, MAX_LOGIN_ATTEMPTS + 1):
        try:
            log.info(f'Discord login attempt {attempt}/{MAX_LOGIN_ATTEMPTS}')
            client.run(token)
            login_ok = True  # only reached if run returns normally (it shouldn't unless stopped)
            break
        except Exception as e:
            log.error(f'Login attempt {attempt} failed', error=str(e))
            if attempt < MAX_LOGIN_ATTEMPTS:
                backoff_ms = min(30000, 2000 * (2 ** (attempt - 1)))
                log.info(f'Retrying in {backoff_ms}ms...')
                time.sleep(backoff_ms / 1000)
            else:
                log.error(f'All {MAX_LOGIN_ATTEMPTS} login attempts failed, exiting')
                sys.exit(4)

    # We never reach here normally — client.run() blocks
    if not login_ok:
        sys.exit(4)


if __name__ == '__main__':
    # Handle SIGTERM for clean shutdown by bot manager
    def sigterm_handler(signum, frame):
        print(f'[bot] Received signal {signum}, exiting', flush=True)
        # discord.py doesn't have a clean way to stop from a signal handler in same thread,
        # but the bot manager will SIGKILL after timeout if needed
        sys.exit(0)

    signal.signal(signal.SIGTERM, sigterm_handler)
    signal.signal(signal.SIGINT, sigterm_handler)
    main()
