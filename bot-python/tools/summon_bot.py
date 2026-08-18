"""summon_bot — bot-to-bot delegation via @mention + wait for reply."""

import asyncio
import json

SUMMON_BOT_TOOL = {
    'type': 'function',
    'function': {
        'name': 'summon_bot',
        'description': "Summon another bot in this fleet to help with a task. Sends an @mention in the current channel asking the target bot to do something, then waits for its reply (up to 60s). Use this to delegate specialized work — e.g. ask a coder bot to run code, ask a research bot to fetch info. The target bot must be authorized in your config (delegated_bots) and must be currently running.",
        'parameters': {
            'type': 'object',
            'properties': {
                'bot_id': {'type': 'string', 'description': 'The ID of the bot to summon. Must be one of your authorized delegated_bots.'},
                'message': {'type': 'string', 'description': 'The message to send to the other bot. Will be prefixed with an @mention.'},
                'timeout_seconds': {'type': 'number', 'description': 'How long to wait for a reply. Default 60, max 120.'},
            },
            'required': ['bot_id', 'message'],
        },
    },
}


async def summon_bot_handler(args, ctx):
    target_id = args.get('bot_id', '').strip()
    message = args.get('message', '').strip()
    timeout_sec = min(int(args.get('timeout_seconds', 60)), 120)
    channel_id = args.get('_channel_id', '').strip()

    if not target_id or not message:
        return json.dumps({'error': 'bot_id and message required'})
    if not channel_id:
        return json.dumps({'error': 'no channel context available'})

    # Authorization check
    delegated = ctx.bot_config.get('delegated_bots') or []
    if target_id not in delegated:
        return json.dumps({
            'error': 'not authorized',
            'hint': f'bot_id "{target_id}" is not in your delegated_bots list. Ask the admin to add it via the web panel.',
        })

    if not ctx.summon_bot:
        return json.dumps({'error': 'summon not available in this context'})
    return await ctx.summon_bot(target_id, message, timeout_sec, channel_id)
