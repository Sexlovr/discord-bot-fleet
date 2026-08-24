// POST /api/bots/fetch-from-hf — manually pull DB from HF dataset repo.
// Also auto-creates the schema if missing.
// Query param: ?force=true — overwrite local DB even if remote has 0 bots

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { pullDbFromHf, isHfPersistEnabled, listRemoteFiles } from '@/lib/hf-persist';
import { reconnectDb } from '@/lib/db';
import { execSync } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import { dirname } from 'path';

function ensureSchemaExists() {
  const dbUrl = process.env.DATABASE_URL || '';
  if (!dbUrl.startsWith('file:')) return;
  const dbPath = dbUrl.slice(5);
  const dir = dirname(dbPath);
  if (dir && !existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  let needsSchema = false;
  if (!existsSync(dbPath)) needsSchema = true;
  else {
    try {
      if (statSync(dbPath).size < 10000) needsSchema = true;
    } catch { needsSchema = true; }
  }
  if (needsSchema) {
    console.log('[fetch-from-hf] schema missing — running prisma db:push...');
    const candidates = [
      'npx prisma db:push --skip-generate --accept-data-loss',
      'node_modules/.bin/prisma db:push --skip-generate --accept-data-loss',
      '/app/next-service-dist/node_modules/.bin/prisma db:push --skip-generate --accept-data-loss',
    ];
    for (const cmd of candidates) {
      try {
        execSync(cmd, { stdio: 'pipe', timeout: 60000, env: process.env });
        console.log(`[fetch-from-hf] schema created via: ${cmd}`);
        return true;
      } catch (e) { /* try next */ }
    }
    return false;
  }
  return true;
}

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isHfPersistEnabled()) {
    return NextResponse.json({ ok: false, error: 'HF persistence not enabled' });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get('force') === 'true';
  try {
    const { stopAllBots } = await import('@/lib/bot');
    await stopAllBots();
    const schemaOk = ensureSchemaExists();
    const result = await pullDbFromHf(force);
    await reconnectDb();
    const files = await listRemoteFiles();
    return NextResponse.json({
      ok: result.ok,
      ...result,
      schema_created: schemaOk,
      remote_files: files,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const enabled = isHfPersistEnabled();
    const files = enabled ? await listRemoteFiles() : [];
    return NextResponse.json({ enabled, remote_files: files });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
