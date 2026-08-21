// AES-256-GCM encryption for bot tokens at rest.
// Master key from MASTER_KEY env var (or compiled-in fallback in env.ts).
// In dev with neither set, falls back to a random key persisted to db/.master-key.

import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { MASTER_KEY } from './env';

const DB_DIR = join(process.cwd(), 'db');
const KEY_FILE = join(DB_DIR, '.master-key');
const SALT = 'discord-bot-fleet-v1-salt';

function getMasterKey(): Buffer {
  // Use the env.ts value (process.env.MASTER_KEY or compiled fallback).
  // IMPORTANT: this MUST be the same key used when tokens were encrypted,
  // otherwise decryptString() will throw on every bot start.
  if (MASTER_KEY) {
    return scryptSync(MASTER_KEY, SALT, 32);
  }
  // Dev fallback — random key persisted to file
  if (!existsSync(KEY_FILE)) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    console.warn('[crypto] WARNING: no MASTER_KEY env, generated dev key at', KEY_FILE);
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
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decryptString(payload: string): string {
  if (!payload || !payload.startsWith('enc:')) return payload; // not encrypted
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

export function maskToken(token: string): string {
  if (!token || token.length <= 16) return '••••';
  return `${token.slice(0, 10)}...${token.slice(-4)}`;
}
