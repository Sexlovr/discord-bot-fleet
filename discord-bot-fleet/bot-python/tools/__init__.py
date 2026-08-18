"""Tool registry — same 8 tools as the Node version. Schema is OpenAI function spec."""

import json
from typing import Any, Callable, Dict, List, Optional

from tools.web_search import WEB_SEARCH_TOOL, web_search_handler
from tools.ping_proxy import PING_PROXY_TOOL, ping_proxy_handler
from tools.fetch_url import FETCH_URL_TOOL, fetch_url_handler
from tools.github import GITHUB_TOOL, github_handler
from tools.memory import MEMORY_READ_TOOL, MEMORY_WRITE_TOOL, memory_read_handler, memory_write_handler
from tools.schedule import SCHEDULE_TOOL, schedule_handler
from tools.summon_bot import SUMMON_BOT_TOOL, summon_bot_handler


class ToolContext:
    def __init__(
        self,
        bot_config: Dict[str, Any],
        send_channel_message: Optional[Callable] = None,
        add_reaction: Optional[Callable] = None,
        summon_bot: Optional[Callable] = None,
        discord_client: Any = None,
    ):
        self.bot_config = bot_config
        self.send_channel_message = send_channel_message
        self.add_reaction = add_reaction
        self.summon_bot = summon_bot
        self.discord_client = discord_client


ALL_TOOLS = {
    'ping_ai_proxy': (PING_PROXY_TOOL, ping_proxy_handler),
    'fetch_url': (FETCH_URL_TOOL, fetch_url_handler),
    'github_lookup': (GITHUB_TOOL, github_handler),
    'memory_read': (MEMORY_READ_TOOL, memory_read_handler),
    'memory_write': (MEMORY_WRITE_TOOL, memory_write_handler),
    'schedule_reminder': (SCHEDULE_TOOL, schedule_handler),
    'web_search': (WEB_SEARCH_TOOL, web_search_handler),
    'summon_bot': (SUMMON_BOT_TOOL, summon_bot_handler),
}


def get_enabled_tools(config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Returns list of OpenAI tool schemas enabled for this bot."""
    tools_cfg = config.get('tools', {})
    enabled = []
    if tools_cfg.get('ping_proxy'):
        enabled.append(ALL_TOOLS['ping_ai_proxy'][0])
    if tools_cfg.get('fetch_url'):
        enabled.append(ALL_TOOLS['fetch_url'][0])
    if tools_cfg.get('github_lookup'):
        enabled.append(ALL_TOOLS['github_lookup'][0])
    if tools_cfg.get('memory'):
        enabled.append(ALL_TOOLS['memory_read'][0])
        enabled.append(ALL_TOOLS['memory_write'][0])
    if tools_cfg.get('schedule_reminder'):
        enabled.append(ALL_TOOLS['schedule_reminder'][0])
    if tools_cfg.get('web_search'):
        enabled.append(ALL_TOOLS['web_search'][0])
    if tools_cfg.get('summon_bot') and config.get('delegated_bots'):
        enabled.append(ALL_TOOLS['summon_bot'][0])
    return enabled


async def dispatch_tool(name: str, args: Dict[str, Any], ctx: ToolContext) -> str:
    if name not in ALL_TOOLS:
        return json.dumps({'error': f'unknown tool: {name}'})
    schema, handler = ALL_TOOLS[name]
    try:
        result = await handler(args, ctx)
        return result
    except Exception as e:
        return json.dumps({'error': str(e)})
