"""Per-bot logger — appends to the same log files Node writes, emits JSON lines.
The Node panel's log bus (EventEmitter) won't pick these up directly via in-process
event emitter, so we write to the log file. The panel's GET /api/bots/:id/logs
endpoint reads the file, so logs will show up there with a slight delay.
"""

import json
import os
import time
from typing import Optional, Dict, Any

DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
LOG_DIR = os.path.join(DATA_DIR, 'logs')

os.makedirs(LOG_DIR, exist_ok=True)


class BotLogger:
    def __init__(self, bot_id: str):
        self.bot_id = bot_id
        self.log_file = os.path.join(LOG_DIR, f'{bot_id}.log')

    def _write(self, level: str, msg: str, meta: Optional[Dict[str, Any]] = None) -> None:
        entry = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
            'level': level,
            'bot_id': self.bot_id,
            'msg': str(msg),
        }
        if meta:
            for k, v in meta.items():
                if k not in ('ts', 'level', 'bot_id', 'msg'):
                    try:
                        entry[k] = str(v)[:300]
                    except Exception:
                        entry[k] = '<unrepresentable>'
        with open(self.log_file, 'a') as f:
            f.write(json.dumps(entry) + '\n')
        # Also print to stdout/stderr for HF logs
        if level == 'error':
            print(f'[{self.bot_id}] {level}: {msg} {meta or {}}', flush=True, file=__import__('sys').stderr)
        else:
            print(f'[{self.bot_id}] {level}: {msg} {meta or {}}', flush=True)

    def debug(self, msg: str, **meta) -> None:
        self._write('debug', msg, meta)

    def info(self, msg: str, **meta) -> None:
        self._write('info', msg, meta)

    def warn(self, msg: str, **meta) -> None:
        self._write('warn', msg, meta)

    def error(self, msg: str, **meta) -> None:
        self._write('error', msg, meta)


def get_logger(bot_id: str) -> BotLogger:
    return BotLogger(bot_id)
