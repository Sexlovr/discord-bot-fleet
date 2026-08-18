"""Config store — reads/writes the same bots.json the Node panel uses.
Uses fcntl file locking to avoid races with the Node process.
"""

import json
import os
import fcntl
import time
from typing import Optional, Dict, Any, List

DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
BOTS_FILE = os.path.join(DATA_DIR, 'bots.json')


def _load() -> Dict[str, Any]:
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(BOTS_FILE):
        with open(BOTS_FILE, 'w') as f:
            json.dump({'bots': []}, f)
        return {'bots': []}
    try:
        with open(BOTS_FILE, 'r') as f:
            fcntl.flock(f.fileno(), fcntl.LOCK_SH)
            data = json.load(f)
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        if 'bots' not in data or not isinstance(data['bots'], list):
            raise ValueError('invalid bots.json')
        return data
    except Exception as e:
        # Backup and start fresh
        backup = BOTS_FILE + f'.bak.{int(time.time())}'
        try:
            os.rename(BOTS_FILE, backup)
            print(f'[store] failed to parse bots.json, backed up to {backup}: {e}', flush=True)
        except Exception:
            pass
        with open(BOTS_FILE, 'w') as f:
            json.dump({'bots': []}, f)
        return {'bots': []}


def _save(data: Dict[str, Any]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = BOTS_FILE + '.tmp'
    with open(tmp, 'w') as f:
        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
    os.replace(tmp, BOTS_FILE)


def list_bots() -> List[Dict[str, Any]]:
    return _load()['bots']


def get_bot(bot_id: str) -> Optional[Dict[str, Any]]:
    for b in _load()['bots']:
        if b.get('id') == bot_id:
            return b
    return None


def update_bot(bot_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    data = _load()
    for i, b in enumerate(data['bots']):
        if b.get('id') == bot_id:
            merged = {**b, **patch, 'id': bot_id, 'updated_at': int(time.time() * 1000)}
            data['bots'][i] = merged
            _save(data)
            return merged
    raise KeyError(f'bot {bot_id} not found')
