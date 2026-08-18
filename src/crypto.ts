// Token encryption at rest.
// Master key comes from MASTER_KEY env var (set via HF Secret in prod).
// In dev, falls back to a random key persisted to data/.master-key (gitignored).

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const KEY_FILE = join(DATA_DIR, '.master-key');
const SALT = 'discord-bot-fleet-v1-salt'; // static salt for key derivation (the secret is the master key itself)

function getMasterKey(): Buffer {
  if (process.env.MASTER_KEY) {
    return scryptSync(process.env.MASTER_KEY, SALT, 32);
  }
  // Dev fallback — random key persisted to disk
  if (!existsSync(KEY_FILE)) {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    console.warn('[crypto] WARNING: no MASTER_KEY env var set, generated random dev key at', KEY_FILE);
    console.warn('[crypto] Set MASTER_KEY via HF Secret for production to keep tokens recoverable across restarts.');
    return key;
  }
  return Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

const ALGO = 'aes-256-gcm';

export function encryptString(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: enc:iv:tag:ciphertext (all hex)
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptString(payload: string): string {
  if (!payload.startsWith('enc:')) return payload; // not encrypted (legacy plaintext)
  const parts = payload.split(':');
  if (parts.length !== 4) throw new Error('invalid encrypted payload format');
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const data = Buffer.from(parts[3], 'hex');
  const key = getMasterKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

export function isEncrypted(payload: string): boolean {
  return payload.startsWith('enc:');
}

// For masking in UI: returns first 10 + last 4 chars, e.g. MTUzOTE5...X9zA
export function maskToken(token: string): string {
  if (token.length <= 16) return '••••';
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}
