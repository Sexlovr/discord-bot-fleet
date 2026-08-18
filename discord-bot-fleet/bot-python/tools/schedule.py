"""schedule_reminder — fire-and-forget reminders using asyncio tasks."""

import asyncio
import json
import re

SCHEDULE_TOOL = {
    'type': 'function',
    'function': {
        'name': 'schedule_reminder',
        'description': 'Schedule a future reminder that posts a message to a channel. Useful for "remind me in 1 hour" or scheduled pings. Delay can be "30m", "1h", "2h", "1d".',
        'parameters': {
            'type': 'object',
            'properties': {
                'delay': {'type': 'string', 'description': 'Time until reminder fires. Format: "30m" / "1h" / "2h" / "1d".'},
                'message': {'type': 'string', 'description': 'Message content to post when the reminder fires.'},
                'channel_id': {'type': 'string', 'description': 'Discord channel ID to post in. If omitted, uses the channel the conversation is happening in.'},
            },
            'required': ['delay', 'message'],
        },
    },
}


def parse_delay(delay: str):
    """Returns delay in seconds, or None if invalid."""
    m = re.match(r'^(\d+)([smhd])$', delay.strip().lower())
    if m:
        n = int(m.group(1))
        unit = m.group(2)
        if unit == 's':
            return n
        if unit == 'm':
            return n * 60
        if unit == 'h':
            return n * 3600
        if unit == 'd':
            return n * 86400
    return None


async def schedule_handler(args, ctx):
    delay_str = args.get('delay', '').strip()
    message = args.get('message', '').strip()
    channel_id = args.get('channel_id') or (ctx.bot_config.get('channel_ids') or [None])[0]
    if not delay_str or not message:
        return json.dumps({'error': 'delay and message are required'})
    seconds = parse_delay(delay_str)
    if seconds is None:
        return json.dumps({'error': f'invalid delay "{delay_str}". Use "30m", "1h", "2h", "1d".'})
    if not channel_id:
        return json.dumps({'error': 'no channel_id provided and bot has no default channel configured'})
    if not ctx.send_channel_message:
        return json.dumps({'error': 'no send_channel_message available in context'})

    async def fire():
        await asyncio.sleep(seconds)
        try:
            await ctx.send_channel_message(channel_id, message)
        except Exception as e:
            print(f'[schedule] failed to send reminder: {e}', flush=True)

    # Schedule but don't await
    asyncio.create_task(fire())
    job_id = f'reminder_{int(asyncio.get_event_loop().time() * 1000)}_{id(fire)}'
    return json.dumps({
        'ok': True,
        'job_id': job_id,
        'delay_seconds': seconds,
        'channel_id': channel_id,
    })
