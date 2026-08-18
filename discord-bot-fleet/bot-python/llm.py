"""Multi-provider LLM client with failover.

Tries providers in priority order. If a provider fails (timeout, network error,
5xx), moves to the next. This way if your primary proxy is down, the bot
automatically falls back to z.ai SDK or another proxy.

Provider types:
  - 'openai'  : OpenAI-compatible REST API (uses curl_cffi + Chrome impersonation
                to bypass HF Space egress blocks)
  - 'zai'     : z.ai SDK (uses z-ai-web-dev-sdk via Node.js subprocess — too
                complex to call directly from Python; we expose it as a CLI call)
"""

import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional

# We use the openai Python SDK for type compatibility, but with a custom
# transport that uses curl_cffi under the hood (for Chrome TLS impersonation).
# This is needed to bypass HF Space's TCP-level block on *.workers.dev.

# Try importing zai SDK (Node.js bridge) — optional, only if needed
ZAI_CLI_PATH = os.environ.get('ZAI_CLI_PATH', 'z-ai')  # CLI: z-ai chat -p ... -o -


class LLMProviderError(Exception):
    pass


class OpenAICompatProvider:
    """OpenAI-compatible provider using curl_cffi for Chrome TLS impersonation."""

    def __init__(self, config: Dict[str, Any]):
        from curl_cffi import requests as cf_requests
        # Lazy-init session — only created on first request
        self._cf = cf_requests
        if config.get('api_key_enc'):
            from crypto import decrypt_string
            api_key = decrypt_string(config['api_key_enc'])
        else:
            api_key = os.environ.get('LLM_API_KEY', 'FAP!')
        self.api_key = api_key
        self.proxy_url = config.get('proxy_url', '')
        self.model = config.get('model', '')
        self.temperature = float(config.get('temperature', 0.8))
        self.max_tokens = int(config.get('max_tokens', 1500))
        self.name = config.get('name', 'openai')
        self._session = None

    async def _get_session(self):
        if self._session is None:
            self._session = self._cf.AsyncSession(
                impersonate='chrome',
                timeout=120,  # generous — LLM can take 30-60s on slow proxies
                headers={
                    'Authorization': f'Bearer {self.api_key}',
                    'User-Agent': 'DiscordBot (https://example.com, 1.0)',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                },
            )
        return self._session

    async def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict]] = None) -> Dict[str, Any]:
        session = await self._get_session()
        url = f'{self.proxy_url}/chat/completions'
        body = {
            'model': self.model,
            'messages': messages,
            'temperature': self.temperature,
            'max_tokens': self.max_tokens,
        }
        if tools:
            body['tools'] = tools
        # curl_cffi async request
        resp = await session.post(url, json=body)
        if resp.status_code != 200:
            raise LLMProviderError(f'{self.name}: HTTP {resp.status_code}: {resp.text[:300]}')
        data = resp.json()
        choice = data.get('choices', [{}])[0]
        msg = choice.get('message', {})
        tool_calls = None
        if msg.get('tool_calls'):
            tool_calls = [
                {
                    'id': tc.get('id', ''),
                    'type': 'function',
                    'function': {
                        'name': tc.get('function', {}).get('name', ''),
                        'arguments': tc.get('function', {}).get('arguments', ''),
                    },
                }
                for tc in msg['tool_calls']
            ]
        usage = data.get('usage') or {}
        return {
            'content': msg.get('content'),
            'tool_calls': tool_calls,
            'finish_reason': choice.get('finish_reason'),
            'usage': {
                'prompt_tokens': usage.get('prompt_tokens'),
                'completion_tokens': usage.get('completion_tokens'),
                'total_tokens': usage.get('total_tokens'),
            } if usage else None,
            'provider_used': self.name,
        }

    async def close(self):
        if self._session:
            await self._session.close()
            self._session = None


class ZaiSdkProvider:
    """z.ai SDK provider — calls `z-ai chat` CLI as subprocess.

    The z-ai-web-dev-sdk is a Node.js package, so we can't import it directly
    from Python. We use the CLI bridge instead.

    Limitations:
    - No tool calling support (z.ai SDK doesn't expose tool calling via CLI)
    - Single-turn only (we manage message history ourselves and concat it into the prompt)
    - Slower (process spawn overhead)
    """

    def __init__(self, config: Dict[str, Any]):
        self.cli_path = ZAI_CLI_PATH
        self.model = config.get('model', 'glm-4.6')
        self.temperature = float(config.get('temperature', 0.8))
        self.max_tokens = int(config.get('max_tokens', 1500))
        self.thinking = config.get('zai_thinking', 'disabled')
        self.name = config.get('name', 'zai-sdk')

    async def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict]] = None) -> Dict[str, Any]:
        if tools:
            # z.ai CLI doesn't support tools — fall back to a note in the prompt
            messages = list(messages) + [{
                'role': 'user',
                'content': '(Note: tool calling is requested but not supported by z.ai SDK provider — reply without tools.)'
            }]

        # Build a single prompt from messages
        system_msgs = [m for m in messages if m.get('role') == 'system']
        convo_msgs = [m for m in messages if m.get('role') != 'system']
        system_prompt = '\n'.join(m.get('content', '') for m in system_msgs)

        # Concatenate conversation into one prompt for z.ai (single-turn)
        prompt_parts = []
        for m in convo_msgs:
            role = m.get('role', 'user')
            content = m.get('content', '')
            if role == 'user':
                prompt_parts.append(f'User: {content}')
            elif role == 'assistant':
                prompt_parts.append(f'Assistant: {content}')
            elif role == 'tool':
                prompt_parts.append(f'(Tool result: {content})')
        prompt = '\n'.join(prompt_parts) + '\nAssistant:'

        # Build CLI command
        cmd = [self.cli_path, 'chat', '--prompt', prompt]
        if system_prompt:
            cmd.extend(['--system', system_prompt])
        if self.thinking == 'enabled':
            cmd.append('--thinking')
        cmd.extend(['--output', '-'])  # output to stdout (we capture)

        # Run as subprocess, capture stdout
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
        except asyncio.TimeoutError:
            proc.kill()
            raise LLMProviderError(f'{self.name}: CLI timeout after 120s')

        if proc.returncode != 0:
            err = stderr.decode('utf-8', errors='replace')[:300]
            raise LLMProviderError(f'{self.name}: CLI exit {proc.returncode}: {err}')

        # Parse JSON from stdout
        try:
            data = json.loads(stdout.decode('utf-8'))
            content = data.get('content') or data.get('response') or ''
        except Exception:
            content = stdout.decode('utf-8', errors='replace').strip()

        return {
            'content': content,
            'tool_calls': None,
            'finish_reason': 'stop',
            'usage': None,
            'provider_used': self.name,
        }

    async def close(self):
        pass


class LLMClient:
    """Multi-provider LLM client with failover.

    Accepts either:
    - A legacy config with `llm` field (single provider, converted to list)
    - A new config with `providers` field (list of providers)

    On chat(), tries providers in priority order. If a provider fails, logs
    the error and tries the next. Returns the first successful response.
    """

    def __init__(self, config: Dict[str, Any]):
        self.providers: List[Any] = []

        # If config has 'providers' field, use it; otherwise convert legacy llm
        providers_config = config.get('providers')
        if not providers_config:
            # Convert legacy llm config (single provider) to a single-item list
            llm_cfg = config.get('llm', {})
            providers_config = [{
                'id': 'default',
                'name': 'Default',
                'type': 'openai',
                'priority': 1,
                'enabled': True,
                'proxy_url': llm_cfg.get('proxy_url', ''),
                'api_key_enc': llm_cfg.get('api_key_enc', ''),
                'model': llm_cfg.get('model', ''),
                'temperature': llm_cfg.get('temperature', 0.8),
                'max_tokens': llm_cfg.get('max_tokens', 1500),
            }]

        # Sort by priority (1 = first)
        providers_config.sort(key=lambda p: p.get('priority', 99))
        for p in providers_config:
            if not p.get('enabled', True):
                continue
            ptype = p.get('type', 'openai')
            if ptype == 'openai':
                self.providers.append(OpenAICompatProvider(p))
            elif ptype == 'zai':
                self.providers.append(ZaiSdkProvider(p))

        if not self.providers:
            raise LLMProviderError('No enabled LLM providers configured')

    async def chat(self, messages: List[Dict[str, Any]], tools: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """Try each provider in priority order. Returns first successful response."""
        errors = []
        for i, provider in enumerate(self.providers):
            try:
                resp = await provider.chat(messages, tools)
                if i > 0:
                    # Mark that we used a fallback
                    resp['used_fallback'] = True
                return resp
            except Exception as e:
                errors.append(f'{provider.name}: {e}')
                # Try next provider
                continue
        # All providers failed
        raise LLMProviderError('All providers failed: ' + ' | '.join(errors))

    async def close(self):
        for p in self.providers:
            try:
                await p.close()
            except Exception:
                pass

    @staticmethod
    async def ping(proxy_url: str, api_key: str, model: Optional[str] = None) -> Dict[str, Any]:
        """Health-check an OpenAI-compatible proxy. Returns status/latency/models."""
        import time
        from curl_cffi import requests as cf_requests
        start = time.time()
        try:
            async with cf_requests.AsyncSession(
                impersonate='chrome',
                timeout=30,
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'User-Agent': 'DiscordBot (https://example.com, 1.0)',
                    'Accept': 'application/json',
                },
            ) as session:
                # GET /models
                r = await session.get(f'{proxy_url}/models')
                if r.status_code != 200:
                    return {
                        'status': 'error',
                        'latency_ms': int((time.time() - start) * 1000),
                        'error': f'HTTP {r.status_code}: {r.text[:200]}',
                    }
                models_resp = r.json()
                models = [m.get('id', '') for m in models_resp.get('data', [])] if isinstance(models_resp, dict) else []

                test_response = None
                if model:
                    body = {
                        'model': model,
                        'messages': [{'role': 'user', 'content': 'Say "hello" in one word.'}],
                        'max_tokens': 10,
                    }
                    r2 = await session.post(f'{proxy_url}/chat/completions', json=body)
                    if r2.status_code == 200:
                        test_response = r2.json().get('choices', [{}])[0].get('message', {}).get('content', '')
                    else:
                        test_response = f'(test failed: HTTP {r2.status_code})'
                return {
                    'status': 'online',
                    'latency_ms': int((time.time() - start) * 1000),
                    'models': models,
                    'test_response': test_response,
                }
        except Exception as e:
            return {
                'status': 'error',
                'latency_ms': int((time.time() - start) * 1000),
                'error': str(e),
            }
