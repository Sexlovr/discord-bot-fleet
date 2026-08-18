"""OpenAI-compatible async LLM client with tool calling."""

import os
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from crypto import decrypt_string


class LLMClient:
    def __init__(self, config: Dict[str, Any]):
        if config['llm'].get('api_key_enc'):
            api_key = decrypt_string(config['llm']['api_key_enc'])
        else:
            api_key = os.environ.get('LLM_API_KEY', 'FAP!')
        self.client = AsyncOpenAI(
            base_url=config['llm']['proxy_url'],
            api_key=api_key,
            timeout=120.0,
        )
        self.model = config['llm']['model']
        self.temperature = config['llm']['temperature']
        self.max_tokens = config['llm']['max_tokens']

    async def chat(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            'model': self.model,
            'messages': messages,
            'temperature': self.temperature,
            'max_tokens': self.max_tokens,
        }
        if tools:
            kwargs['tools'] = tools
        resp = await self.client.chat.completions.create(**kwargs)
        choice = resp.choices[0]
        tool_calls = None
        if choice.message.tool_calls:
            tool_calls = [
                {
                    'id': tc.id,
                    'type': 'function',
                    'function': {
                        'name': tc.function.name,
                        'arguments': tc.function.arguments,
                    },
                }
                for tc in choice.message.tool_calls
            ]
        usage = None
        if resp.usage:
            usage = {
                'prompt_tokens': resp.usage.prompt_tokens,
                'completion_tokens': resp.usage.completion_tokens,
                'total_tokens': resp.usage.total_tokens,
            }
        return {
            'content': choice.message.content,
            'tool_calls': tool_calls,
            'finish_reason': choice.finish_reason,
            'usage': usage,
        }

    @staticmethod
    async def ping(proxy_url: str, api_key: str, model: Optional[str] = None) -> Dict[str, Any]:
        import time
        start = time.time()
        try:
            client = AsyncOpenAI(base_url=proxy_url, api_key=api_key, timeout=30.0)
            models_resp = await client.models.list()
            models = [m.id for m in models_resp.data] if hasattr(models_resp, 'data') else []
            test_response = None
            if model:
                chat = await client.chat.completions.create(
                    model=model,
                    messages=[{'role': 'user', 'content': 'Say "hello" in one word.'}],
                    max_tokens=10,
                )
                test_response = chat.choices[0].message.content or ''
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
