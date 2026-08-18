"""AES-256-GCM decryption — compatible with Node's crypto.ts encryptString().

Node format: enc:iv_hex:tag_hex:ciphertext_hex
Python's cryptography lib expects ciphertext+tag concatenated for AESGCM.decrypt().
"""

import os
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

SALT = b'discord-bot-fleet-v1-salt'  # must match src/crypto.ts
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
KEY_FILE = os.path.join(DATA_DIR, '.master-key')

_master_key_cache = None


def get_master_key() -> bytes:
    global _master_key_cache
    if _master_key_cache is not None:
        return _master_key_cache

    master_key_env = os.environ.get('MASTER_KEY')
    if master_key_env:
        kdf = Scrypt(salt=SALT, length=32, n=2 ** 14, r=8, p=1)
        _master_key_cache = kdf.derive(master_key_env.encode())
        return _master_key_cache

    # Dev fallback — read from file (must match Node's fallback format)
    if os.path.exists(KEY_FILE):
        with open(KEY_FILE, 'r') as f:
            _master_key_cache = bytes.fromhex(f.read().strip())
        return _master_key_cache

    # Generate new dev key (Node will pick this up via its own fallback)
    os.makedirs(DATA_DIR, exist_ok=True)
    _master_key_cache = AESGCM.generate_key(bit_length=256)
    with open(KEY_FILE, 'w') as f:
        f.write(_master_key_cache.hex())
    try:
        os.chmod(KEY_FILE, 0o600)
    except Exception:
        pass
    print(f'[crypto] WARNING: no MASTER_KEY env, generated dev key at {KEY_FILE}', file=sys.stderr)
    return _master_key_cache


def decrypt_string(payload: str) -> str:
    if not payload or not payload.startswith('enc:'):
        return payload  # not encrypted (legacy plaintext)
    parts = payload.split(':')
    if len(parts) != 4:
        raise ValueError('invalid encrypted payload format')
    iv = bytes.fromhex(parts[1])
    tag = bytes.fromhex(parts[2])
    data = bytes.fromhex(parts[3])
    key = get_master_key()
    aesgcm = AESGCM(key)
    # cryptography lib expects ciphertext + tag concatenated
    plaintext = aesgcm.decrypt(iv, data + tag, None)
    return plaintext.decode('utf-8')


def mask_token(token: str) -> str:
    if not token or len(token) <= 16:
        return '••••' if token else ''
    return f'{token[:10]}...{token[-4:]}'
