// POST /api/bots/sync-to-hf — manually push DB to HF dataset repo
// GET /api/bots/sync-to-hf — check HF persistence status

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { pushNow, isHfPersistEnabled, listRemoteFiles } from '@/lib/hf-persist';

export async function POST(req: NextRequest) {
  if (!(await requireAuth())) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isHfPersistEnabled()) {
    return NextResponse.json({ ok: false, error: 'HF persistence not enabled (HF_TOKEN or HF_DATASET_REPO not set)' });
  }
  try {
    const result = await pushNow();
    const files = await listRemoteFiles();
    return NextResponse.json({ ...result, remote_files: files });
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
