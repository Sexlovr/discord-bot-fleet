"""memory — persistent per-bot memory. Same JSON file as Node, size-capped."""

import json
import os
import re
from typing import Dict

DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data'))
MEMORY_DIR = os.path.join(DATA_DIR, 'memory')
os.makedirs(MEMORY_DIR, exist_ok=True)

MAX_KEYS = 500
MAX_VALUE_BYTES = 16 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024

MEM_PERSONA_READ = {
    'type': 'function',
    'function': {
        'name': 'memory_read',
        'description': 'Read a value from your persistent memory by key, or list all keys if no key is given. Use this to recall things about users, ongoing topics, or anything you decided to remember.',
        'parameters': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Memory key to read. If omitted, returns a list of all keys.'},
            },
        },
    },
}

MEM_PERSONA_WRITE = {
    'type': 'function',
    'function': {
        'name': 'memory_write',
        'description': 'Write a key/value pair to your persistent memory. Use this to remember facts about users, ongoing conversations, decisions, or anything you want to recall later. Values are limited to 16KB; max 500 keys per bot.',
        'parameters': {
            'type': 'object',
            'properties': {
                'key': {'type': 'string', 'description': 'Memory key (use snake_case, e.g. "user_bob_favorite_lang"). Max 100 chars.'},
                'value': {'type': 'string', 'description': 'Value to store. Max 16KB.'},
            },
            'required': ['key', 'value'],
        },
    },
}

# Export under the names the registry expects
MEMORY_READ_TOOL = MEM_PERSONA_READ
MEMORY_WRITE_TOOL = MEM_PERSONA_WRITE


def _memory_file(bot_id: str) -> str:
    safe = re.sub(r'[^a-zA-Z0-9_-]', '', bot_id)
    return os.path.join(MEMORY_DIR, f'{safe}.json')


def _load_memory(bot_id: str) -> Dict[str, str]:
    f = _memory_file(bot_id)
    if not os.path.exists(f):
        return {}
    try:
        with open(f, 'r') as fh:
            return json.load(fh)
    except Exception:
        return {}


def _save_memory(bot_id: str, mem: Dict[str, str]) -> None:
    f = _memory_file(bot_id)
    serialized = json.dumps(mem)
    if len(serialized) > MAX_FILE_BYTES:
        raise ValueError(f'memory file would exceed {MAX_FILE_BYTES} bytes — too many keys/values')
    with open(f, 'w') as fh:
        fh.write(serialized)


async def memory_read_handler(args, ctx):
    key = args.get('key')
    mem = _load_memory(ctx.bot_config['id'])
    if not key:
        return json.dumps({'keys': list(mem.keys()), 'count': len(mem)})
    if key in mem:
        return json.dumps({'key': key, 'value': mem[key]})
    return json.dumps({'key': key, 'value': None, 'note': 'key not found'})


async def memory_write_handler(args, ctx):
    key = args.get('key', '')
    value = args.get('value', '')
    if not isinstance(key, str) or not key:
        return json.dumps({'error': 'key must be a non-empty string'})
    if len(key) > 100:
        return json.dumps({'error': f'key too long ({len(key)} > 100 chars)'})
    if not isinstance(value, str):
        return json.dumps({'error': 'value must be a string'})
    value_bytes = len(value.encode('utf-8'))
    if value_bytes > MAX_VALUE_BYTES:
        return json.dumps({'error': f'value too large ({value_bytes} bytes > {MAX_VALUE_BYTES}). Truncate or split into multiple keys.'})
    mem = _load_memory(ctx.bot_config['id'])
    if key not in mem and len(mem) >= MAX_KEYS:
        return json.dumps({'error': f'memory full: {MAX_KEYS} keys max. Delete some keys first.'})
    mem[key] = value
    try:
        _save_memory(ctx.bot_config['id'], mem)
    except Exception as e:
        return json.dumps({'error': str(e)})
    return json.dumps({'ok': True, 'key': key, 'size_bytes': value_bytes})
