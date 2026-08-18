"""ping_ai_proxy — health-check an OpenAI-compatible LLM proxy."""

import json
from llm import LLMClient
from crypto import decrypt_string
import os

PING_PROXY_TOOL = {
    'type': 'function',
    'function': {
        'name': 'ping_ai_proxy',
        'description': "Health-check an OpenAI-compatible LLM proxy. Returns status, latency, available models, and optionally a test response. Useful for monitoring which proxies are alive.",
        'parameters': {
            'type': 'object',
            'properties': {
                'proxy_url': {'type': 'string', 'description': 'Base URL of the OpenAI-compatible proxy, e.g. https://example.com/v1'},
                'api_key': {'type': 'string', 'description': "API key for the proxy. Optional — falls back to the bot's configured key."},
                'model': {'type': 'string', 'description': 'If provided, also sends a test "hello" message to this model and returns the response.'},
            },
            'required': ['proxy_url'],
        },
    },
}


async def ping_proxy_handler(args, ctx):
    proxy_url = args.get('proxy_url', '').strip()
    if not proxy_url:
        return json.dumps({'error': 'proxy_url required'})
    api_key = args.get('api_key')
    if not api_key:
        if ctx.bot_config.get('llm', {}).get('api_key_enc'):
            api_key = decrypt_string(ctx.bot_config['llm']['api_key_enc'])
        else:
            api_key = os.environ.get('LLM_API_KEY', 'FAP!')
    model = args.get('model')
    result = await LLMClient.ping(proxy_url, api_key, model)
    return json.dumps(result)
